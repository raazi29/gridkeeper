//! Dev-server port detection: LISTENING TCP sockets owned by a process inside a session's process
//! tree.
//!
//! - Windows: `GetExtendedTcpTable` (IPv4 + IPv6, `TCP_TABLE_OWNER_PID_LISTENER`). Cost: two table
//!   reads (a few hundred rows, well under a millisecond) plus one Toolhelp snapshot (~6-7 ms, see
//!   `diagnostics`).
//! - Linux: LISTEN rows of `/proc/net/tcp` + `/proc/net/tcp6` (socket inodes), matched against the
//!   `socket:[inode]` links in `/proc/<pid>/fd` of the session trees' processes only.
//! - macOS: `lsof -nP -a -p <session pids> -iTCP -sTCP:LISTEN -F...` through `run_with_timeout`.
//!
//! The frontend calls this only while a view that shows ports is open, or once after a session's
//! activity changes — never on a constant timer.

use std::collections::{BTreeMap, HashMap};
use std::net::{Ipv4Addr, Ipv6Addr};

use serde::Serialize;

use crate::types::SessionId;

/// One listening socket from the OS table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListenEntry {
    pub port: u16,
    pub pid: u32,
    pub address: String,
}

/// A port a session listens on (v4 and v6 sockets on the same port are merged).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPort {
    pub port: u16,
    pub pid: u32,
    /// Bound addresses, e.g. ["0.0.0.0", "::"] or ["127.0.0.1"].
    pub addresses: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPorts {
    pub id: SessionId,
    pub ports: Vec<SessionPort>,
}

const MIB_TCP_STATE_LISTEN: u32 = 2;
const V4_ROW: usize = 24; // MIB_TCPROW_OWNER_PID: 6 x u32
const V6_ROW: usize = 56; // MIB_TCP6ROW_OWNER_PID: 16 + 4 + 4 + 16 + 4 + 4 + 4 + 4

fn u32_at(b: &[u8], off: usize) -> Option<u32> {
    b.get(off..off + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

/// `dwLocalPort` holds the port in network byte order in its low 16 bits.
pub fn port_from_dword(v: u32) -> u16 {
    (((v & 0xff) << 8) | ((v >> 8) & 0xff)) as u16
}

/// Parse a `MIB_TCPTABLE_OWNER_PID` buffer. Rows past the end of the buffer are ignored.
pub fn parse_tcp4_table(buf: &[u8]) -> Vec<ListenEntry> {
    let Some(n) = u32_at(buf, 0) else { return Vec::new() };
    let mut out = Vec::new();
    for i in 0..n as usize {
        let off = 4 + i * V4_ROW;
        let (Some(state), Some(addr), Some(port), Some(pid)) =
            (u32_at(buf, off), u32_at(buf, off + 4), u32_at(buf, off + 8), u32_at(buf, off + 20))
        else {
            break;
        };
        if state != MIB_TCP_STATE_LISTEN {
            continue;
        }
        // dwLocalAddr is in network byte order too: its in-memory bytes are the dotted quad.
        let a = addr.to_le_bytes();
        out.push(ListenEntry { port: port_from_dword(port), pid, address: Ipv4Addr::new(a[0], a[1], a[2], a[3]).to_string() });
    }
    out
}

/// Parse a `MIB_TCP6TABLE_OWNER_PID` buffer.
pub fn parse_tcp6_table(buf: &[u8]) -> Vec<ListenEntry> {
    let Some(n) = u32_at(buf, 0) else { return Vec::new() };
    let mut out = Vec::new();
    for i in 0..n as usize {
        let off = 4 + i * V6_ROW;
        let Some(row) = buf.get(off..off + V6_ROW) else { break };
        let (Some(port), Some(state), Some(pid)) = (u32_at(row, 20), u32_at(row, 48), u32_at(row, 52)) else { break };
        if state != MIB_TCP_STATE_LISTEN {
            continue;
        }
        let mut a = [0u8; 16];
        a.copy_from_slice(&row[..16]);
        out.push(ListenEntry { port: port_from_dword(port), pid, address: Ipv6Addr::from(a).to_string() });
    }
    out
}

/// Attribute listeners to sessions by process tree. Ports are sorted; a pid in several trees
/// (overlapping roots) counts for each.
pub fn assign(entries: &[ListenEntry], trees: &[(SessionId, Vec<u32>)]) -> Vec<SessionPorts> {
    let mut by_pid: HashMap<u32, Vec<&ListenEntry>> = HashMap::new();
    for e in entries {
        if e.port != 0 {
            by_pid.entry(e.pid).or_default().push(e);
        }
    }
    let mut out = Vec::new();
    for (id, pids) in trees {
        let mut ports: BTreeMap<u16, SessionPort> = BTreeMap::new();
        for pid in pids {
            for e in by_pid.get(pid).into_iter().flatten() {
                let p = ports.entry(e.port).or_insert_with(|| SessionPort { port: e.port, pid: e.pid, addresses: Vec::new() });
                if !p.addresses.contains(&e.address) {
                    p.addresses.push(e.address.clone());
                }
            }
        }
        if !ports.is_empty() {
            out.push(SessionPorts { id: id.clone(), ports: ports.into_values().collect() });
        }
    }
    out
}

#[cfg(windows)]
fn read_table(af: u16) -> Vec<u8> {
    use windows_sys::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, NO_ERROR};
    use windows_sys::Win32::NetworkManagement::IpHelper::{GetExtendedTcpTable, TCP_TABLE_OWNER_PID_LISTENER};
    let mut size: u32 = 0;
    // Retry a few times: the table can grow between the size query and the read.
    for _ in 0..4 {
        let mut buf = vec![0u8; size.max(4) as usize];
        // SAFETY: `buf` is writable for `size` bytes; the API writes at most `size` bytes and
        // updates `size` with the required length on ERROR_INSUFFICIENT_BUFFER.
        let rc = unsafe {
            GetExtendedTcpTable(buf.as_mut_ptr().cast(), &mut size, 0, af as u32, TCP_TABLE_OWNER_PID_LISTENER, 0)
        };
        if rc == NO_ERROR {
            buf.truncate(size as usize);
            return buf;
        }
        if rc != ERROR_INSUFFICIENT_BUFFER {
            return Vec::new();
        }
        size += 1024;
    }
    Vec::new()
}

/// Every LISTENING TCP socket on the machine (IPv4 + IPv6).
#[cfg(windows)]
pub fn listening() -> Vec<ListenEntry> {
    use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_INET6};
    let mut v = parse_tcp4_table(&read_table(AF_INET));
    v.extend(parse_tcp6_table(&read_table(AF_INET6)));
    v
}

/// One LISTEN socket from `/proc/net/tcp{,6}`: (port, address, socket inode).
pub type ProcNetListen = (u16, String, u64);

const PROC_TCP_LISTEN: &str = "0A";

/// Address column of `/proc/net/tcp{,6}`: the address bytes as the kernel holds them (network
/// order), printed as 32-bit words in host byte order.
fn proc_net_addr(hex: &str, v6: bool) -> Option<String> {
    let words = if v6 { 4 } else { 1 };
    if hex.len() != words * 8 {
        return None;
    }
    let mut bytes = Vec::with_capacity(words * 4);
    for i in 0..words {
        let w = u32::from_str_radix(&hex[i * 8..i * 8 + 8], 16).ok()?;
        bytes.extend_from_slice(&w.to_ne_bytes());
    }
    Some(if v6 {
        let mut a = [0u8; 16];
        a.copy_from_slice(&bytes);
        Ipv6Addr::from(a).to_string()
    } else {
        Ipv4Addr::new(bytes[0], bytes[1], bytes[2], bytes[3]).to_string()
    })
}

/// LISTEN rows of a `/proc/net/tcp` (`v6 = false`) or `/proc/net/tcp6` file. The header and
/// malformed lines are skipped.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn parse_proc_net_tcp(text: &str, v6: bool) -> Vec<ProcNetListen> {
    let mut out = Vec::new();
    for line in text.lines().skip(1) {
        let cols: Vec<&str> = line.split_whitespace().collect();
        // sl local rem st tx:rx tr:when retrnsmt uid timeout inode ...
        if cols.len() < 10 || cols[3] != PROC_TCP_LISTEN {
            continue;
        }
        let Some((addr, port)) = cols[1].split_once(':') else { continue };
        let (Some(address), Ok(port), Ok(inode)) = (proc_net_addr(addr, v6), u16::from_str_radix(port, 16), cols[9].parse::<u64>())
        else {
            continue;
        };
        if inode != 0 {
            out.push((port, address, inode));
        }
    }
    out
}

/// `socket:[12345]` (an `/proc/<pid>/fd/<n>` link target) → 12345.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn socket_inode(link: &str) -> Option<u64> {
    link.strip_prefix("socket:[")?.strip_suffix(']')?.parse().ok()
}

/// `host:port` from lsof's name field (`*:3000`, `127.0.0.1:5173`, `[::1]:8080`). A `*` wildcard
/// becomes `0.0.0.0` or `::` depending on the socket type.
fn lsof_name(name: &str, ipv6: bool) -> Option<(String, u16)> {
    // A listening socket has no "->remote" part; be lenient if one appears.
    let local = name.split("->").next()?;
    let (host, port) = local.rsplit_once(':')?;
    let port: u16 = port.parse().ok()?;
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let host = match host {
        "*" if ipv6 => "::".to_string(),
        "*" => "0.0.0.0".to_string(),
        h => h.to_string(),
    };
    Some((host, port))
}

/// Parse `lsof -F pPtn` output: `p<pid>` starts a process, `f<fd>` a file, `t` = IPv4 / IPv6,
/// `P` = protocol, `n` = name. Field order inside a file set is not assumed.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn parse_lsof(text: &str) -> Vec<ListenEntry> {
    #[derive(Default)]
    struct File {
        ipv6: bool,
        proto: Option<String>,
        name: Option<String>,
    }
    fn flush(pid: Option<u32>, file: &mut Option<File>, out: &mut Vec<ListenEntry>) {
        if let (Some(pid), Some(f)) = (pid, file.take())
            && f.proto.as_deref().is_none_or(|p| p.eq_ignore_ascii_case("TCP"))
            && let Some((address, port)) = f.name.as_deref().and_then(|n| lsof_name(n, f.ipv6))
        {
            out.push(ListenEntry { port, pid, address });
        }
    }
    let mut out = Vec::new();
    let mut pid: Option<u32> = None;
    let mut file: Option<File> = None;
    for line in text.lines() {
        let (tag, value) = match line.chars().next() {
            Some(c) => (c, &line[c.len_utf8()..]),
            None => continue,
        };
        match tag {
            'p' => {
                flush(pid, &mut file, &mut out);
                pid = value.trim().parse().ok();
            }
            'f' => {
                flush(pid, &mut file, &mut out);
                file = Some(File::default());
            }
            't' => file.get_or_insert_with(File::default).ipv6 = value.trim().eq_ignore_ascii_case("IPv6"),
            'P' => file.get_or_insert_with(File::default).proto = Some(value.trim().to_string()),
            'n' => file.get_or_insert_with(File::default).name = Some(value.trim().to_string()),
            _ => {}
        }
    }
    flush(pid, &mut file, &mut out);
    out
}

/// LISTEN sockets owned by `pids` (Linux: inode match through `/proc`).
#[cfg(target_os = "linux")]
fn listening_for(pids: &std::collections::HashSet<u32>) -> Vec<ListenEntry> {
    let mut by_inode: HashMap<u64, Vec<(u16, String)>> = HashMap::new();
    for (path, v6) in [("/proc/net/tcp", false), ("/proc/net/tcp6", true)] {
        if let Ok(text) = std::fs::read_to_string(path) {
            for (port, address, inode) in parse_proc_net_tcp(&text, v6) {
                by_inode.entry(inode).or_default().push((port, address));
            }
        }
    }
    let mut out = Vec::new();
    if by_inode.is_empty() {
        return out;
    }
    for &pid in pids {
        // Other users' processes are unreadable; sessions are ours.
        let Ok(dir) = std::fs::read_dir(format!("/proc/{pid}/fd")) else { continue };
        for entry in dir.flatten() {
            let Ok(link) = std::fs::read_link(entry.path()) else { continue };
            let Some(inode) = socket_inode(&link.to_string_lossy()) else { continue };
            for (port, address) in by_inode.get(&inode).into_iter().flatten() {
                out.push(ListenEntry { port: *port, pid, address: address.clone() });
            }
        }
    }
    out
}

/// LISTEN sockets owned by `pids` (macOS: one `lsof` call limited to those pids).
#[cfg(target_os = "macos")]
fn listening_for(pids: &std::collections::HashSet<u32>) -> Vec<ListenEntry> {
    use crate::adapters::process;
    if pids.is_empty() {
        return Vec::new();
    }
    let lsof = ["/usr/sbin/lsof", "/usr/bin/lsof"]
        .iter()
        .map(std::path::PathBuf::from)
        .find(|p| p.is_file())
        .or_else(|| which::which("lsof").ok());
    let Some(lsof) = lsof else { return Vec::new() };
    let mut list: Vec<u32> = pids.iter().copied().collect();
    list.sort_unstable();
    let list = list.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
    let mut cmd = process::hidden_command(lsof);
    cmd.args(["-nP", "-w", "-a", "-p", &list, "-iTCP", "-sTCP:LISTEN", "-FpPtn"]);
    // Exit code 1 just means "nothing found"; parse whatever came out.
    match process::run_with_timeout(cmd, std::time::Duration::from_secs(5)) {
        Ok(out) => parse_lsof(&String::from_utf8_lossy(&out.stdout)),
        Err(e) => {
            tracing::debug!(error = %e, "lsof failed");
            Vec::new()
        }
    }
}

/// Ports each running session listens on (sessions without listeners are omitted).
#[cfg(windows)]
pub fn session_ports(roots: &[(SessionId, u32)]) -> Vec<SessionPorts> {
    if roots.is_empty() {
        return Vec::new();
    }
    let entries = listening();
    if entries.is_empty() {
        return Vec::new();
    }
    assign(&entries, &crate::diagnostics::session_trees(roots))
}

/// Ports each running session listens on (sessions without listeners are omitted). Unix: the
/// trees come first, so only their processes' sockets are looked up.
#[cfg(unix)]
pub fn session_ports(roots: &[(SessionId, u32)]) -> Vec<SessionPorts> {
    if roots.is_empty() {
        return Vec::new();
    }
    let trees = crate::diagnostics::session_trees(roots);
    let pids: std::collections::HashSet<u32> = trees.iter().flat_map(|(_, p)| p.iter().copied()).collect();
    let entries = listening_for(&pids);
    if entries.is_empty() {
        return Vec::new();
    }
    assign(&entries, &trees)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v4_row(state: u32, addr: [u8; 4], port: u16, pid: u32) -> Vec<u8> {
        let mut r = Vec::new();
        r.extend(state.to_le_bytes());
        r.extend(addr); // network order bytes
        r.extend([(port >> 8) as u8, port as u8, 0, 0]); // network-order port in the low word
        r.extend(0u32.to_le_bytes());
        r.extend(0u32.to_le_bytes());
        r.extend(pid.to_le_bytes());
        assert_eq!(r.len(), V4_ROW);
        r
    }

    fn v6_row(state: u32, addr: [u8; 16], port: u16, pid: u32) -> Vec<u8> {
        let mut r = Vec::new();
        r.extend(addr);
        r.extend(0u32.to_le_bytes()); // scope
        r.extend([(port >> 8) as u8, port as u8, 0, 0]);
        r.extend([0u8; 16]);
        r.extend(0u32.to_le_bytes());
        r.extend(0u32.to_le_bytes());
        r.extend(state.to_le_bytes());
        r.extend(pid.to_le_bytes());
        assert_eq!(r.len(), V6_ROW);
        r
    }

    #[test]
    fn port_byte_order() {
        // 5173 = 0x1435 -> memory bytes 14 35 -> LE dword 0x3514
        assert_eq!(port_from_dword(0x3514), 5173);
        assert_eq!(port_from_dword(0x5000), 80);
        assert_eq!(port_from_dword(0xABCD_3514), 5173, "high word is ignored");
    }

    #[test]
    fn parses_v4_table() {
        let mut buf = 3u32.to_le_bytes().to_vec();
        buf.extend(v4_row(2, [127, 0, 0, 1], 5173, 100));
        buf.extend(v4_row(5, [10, 0, 0, 2], 443, 101)); // established: skipped
        buf.extend(v4_row(2, [0, 0, 0, 0], 3000, 102));
        let v = parse_tcp4_table(&buf);
        assert_eq!(
            v,
            vec![
                ListenEntry { port: 5173, pid: 100, address: "127.0.0.1".into() },
                ListenEntry { port: 3000, pid: 102, address: "0.0.0.0".into() },
            ]
        );
        // Truncated buffer: count says 3 but only one row present.
        let mut short = 3u32.to_le_bytes().to_vec();
        short.extend(v4_row(2, [127, 0, 0, 1], 8080, 7));
        assert_eq!(parse_tcp4_table(&short).len(), 1);
        assert!(parse_tcp4_table(&[1, 0]).is_empty());
    }

    #[test]
    fn parses_v6_table() {
        let mut buf = 2u32.to_le_bytes().to_vec();
        let mut loopback = [0u8; 16];
        loopback[15] = 1;
        buf.extend(v6_row(2, loopback, 5173, 100));
        buf.extend(v6_row(2, [0u8; 16], 8080, 200));
        let v = parse_tcp6_table(&buf);
        assert_eq!(v[0], ListenEntry { port: 5173, pid: 100, address: "::1".into() });
        assert_eq!(v[1].address, "::");
        assert_eq!(v[1].port, 8080);
    }

    #[test]
    fn assigns_ports_to_session_trees() {
        let entries = vec![
            ListenEntry { port: 5173, pid: 11, address: "127.0.0.1".into() },
            ListenEntry { port: 5173, pid: 11, address: "::1".into() },
            ListenEntry { port: 3000, pid: 12, address: "0.0.0.0".into() },
            ListenEntry { port: 9000, pid: 99, address: "0.0.0.0".into() }, // not ours
            ListenEntry { port: 0, pid: 11, address: "0.0.0.0".into() },
        ];
        let trees = vec![("a".to_string(), vec![10, 11, 12]), ("b".to_string(), vec![20])];
        let got = assign(&entries, &trees);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].id, "a");
        let ports: Vec<u16> = got[0].ports.iter().map(|p| p.port).collect();
        assert_eq!(ports, vec![3000, 5173]);
        assert_eq!(got[0].ports[1].addresses, vec!["127.0.0.1".to_string(), "::1".to_string()]);
    }

    /// Real-shaped `/proc/net/tcp` / `tcp6` (x86_64 / aarch64, i.e. little-endian words).
    const PROC_TCP: &str = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 37811 1 0000000000000000 100 0 0 10 0
   1: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 37812 1 0000000000000000 100 0 0 10 0
   2: 0100007F:1435 0100007F:A2C4 01 00000000:00000000 00:00000000 00000000  1000        0 0 1 0000000000000000 20 4 30 10 -1
   3: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 0 1 0000000000000000 100 0 0 10 0
   4: garbage
";
    const PROC_TCP6: &str = "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000001000000:1435 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41000 1 0000000000000000 100 0 0 10 0
   1: 00000000000000000000000000000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41001 1 0000000000000000 100 0 0 10 0
   2: 0000000000000000FFFF00000100007F:0016 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 41002 1 0000000000000000 100 0 0 10 0
";

    #[test]
    fn parses_proc_net_tcp() {
        let v4 = parse_proc_net_tcp(PROC_TCP, false);
        assert_eq!(
            v4,
            vec![(5173, "127.0.0.1".to_string(), 37811), (3000, "0.0.0.0".to_string(), 37812)],
            "established rows, inode 0 and garbage are skipped"
        );
        let v6 = parse_proc_net_tcp(PROC_TCP6, true);
        assert_eq!(v6[0], (5173, "::1".to_string(), 41000));
        assert_eq!(v6[1], (8080, "::".to_string(), 41001));
        assert_eq!(v6[2], (22, "::ffff:127.0.0.1".to_string(), 41002));
        // A v4 file read as v6 (wrong width) yields nothing rather than nonsense.
        assert!(parse_proc_net_tcp(PROC_TCP, true).is_empty());
        assert!(parse_proc_net_tcp("", false).is_empty());
        assert_eq!(socket_inode("socket:[37811]"), Some(37811));
        assert_eq!(socket_inode("pipe:[37811]"), None);
        assert_eq!(socket_inode("/dev/pts/3"), None);
    }

    #[test]
    fn parses_lsof_fields() {
        let out = "p4242\nf23\ntIPv4\nPTCP\nn*:3000\nf24\ntIPv6\nPTCP\nn*:3000\nf25\ntIPv6\nPTCP\nn[::1]:5173\np77\nf5\ntIPv4\nPTCP\nn127.0.0.1:8080\nf6\nPUDP\nn*:5353\n";
        let v = parse_lsof(out);
        assert_eq!(
            v,
            vec![
                ListenEntry { port: 3000, pid: 4242, address: "0.0.0.0".into() },
                ListenEntry { port: 3000, pid: 4242, address: "::".into() },
                ListenEntry { port: 5173, pid: 4242, address: "::1".into() },
                ListenEntry { port: 8080, pid: 77, address: "127.0.0.1".into() },
            ],
            "UDP is skipped"
        );
        // Field order inside a file set is not assumed; junk is ignored.
        assert_eq!(parse_lsof("p9\nf1\nn127.0.0.1:9000\nPTCP\n\nxjunk\n")[0], ListenEntry { port: 9000, pid: 9, address: "127.0.0.1".into() });
        assert!(parse_lsof("").is_empty());
        assert!(parse_lsof("f1\nn*:80\n").is_empty(), "no pid → nothing");
    }

    #[cfg(unix)]
    #[test]
    fn finds_own_listener_unix() {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let me = std::process::id();
        let got = session_ports(&[("me".into(), me)]);
        let mine = got.iter().find(|s| s.id == "me").unwrap_or_else(|| panic!("no ports for this process: {got:?}"));
        let p = mine.ports.iter().find(|p| p.port == port).unwrap_or_else(|| panic!("port {port} not found: {mine:?}"));
        assert_eq!(p.pid, me);
        assert_eq!(p.addresses, vec!["127.0.0.1".to_string()]);
    }

    #[cfg(windows)]
    #[test]
    fn finds_own_listener() {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let me = std::process::id();
        let all = listening();
        assert!(all.iter().any(|e| e.port == port && e.pid == me), "port {port} not found");
        let got = session_ports(&[("me".into(), me)]);
        assert!(got.iter().any(|s| s.id == "me" && s.ports.iter().any(|p| p.port == port)));
    }
}
