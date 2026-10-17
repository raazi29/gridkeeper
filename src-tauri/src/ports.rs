//! Dev-server port detection: LISTENING TCP sockets owned by a process inside a session's process
//! tree (`GetExtendedTcpTable`, IPv4 + IPv6, `TCP_TABLE_OWNER_PID_LISTENER`).
//!
//! Cost: two table reads (a few hundred rows, well under a millisecond) plus one Toolhelp snapshot
//! (~6-7 ms, see `diagnostics`). The frontend calls this only while a view that shows ports is open,
//! or once after a session's activity changes — never on a constant timer.

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

#[cfg(not(windows))]
pub fn listening() -> Vec<ListenEntry> {
    Vec::new()
}

/// Ports each running session listens on (sessions without listeners are omitted).
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
