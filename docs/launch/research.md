# Launch video research

How strong developer-tool launch videos and README demos are put together, and which of those principles this
launch uses. Researched October 2026.

How to read the sources:

- **read**: the page was opened and read.
- **search**: the claim came from search-result snippets; the page itself could not be opened (several sites block
  automated fetching).
- **unverified**: no source was found. These are working assumptions and are labelled as such.

## What specific launches do

| Launch | What it does | Source |
|---|---|---|
| Linear, *Introducing Linear Initiatives* (Jun 2024, 4:15) | The product UI fills the frame. The presenter is only a small webcam circle in a corner. The point made in the breakdown: a 50/50 presenter/UI split makes the UI unreadable on a phone. | read: [moonb.io breakdown](https://www.moonb.io/blog/product-launch-video) |
| Linear, mobile launch page | Dark, grainy look, done as a CSS animation rather than a video file. | read: [retroswork study](https://retroswork.substack.com/p/1-study-linear-mobile-launch) |
| Warp, *Introducing Warp 2.0* (Jun 2025, 2:27) | Founder on camera on a dark set, short labels such as "Edit" over the shot, chapter timestamps in the description so viewers can jump to a feature. | read: [moonb.io](https://www.moonb.io/blog/product-launch-video) |
| Raycast, *New Raycast. Coming 2026* (Dec 2025, 0:39 teaser) | Only cropped, dark close-ups of the real interface (search bar, tile grid, list of actions). Existing users recognise the real UI, and there is nothing to walk back at launch. | read: [moonb.io](https://www.moonb.io/blog/product-launch-video) |
| Raycast explainer (2023) | Shows each keystroke on screen as an overlay. | search: [echai.ventures](https://echai.ventures/videos/raycast-raycast-full-tutorial) |
| Claude Code, *Introducing Claude Code* (Feb 2025) | A terminal demo on a real repo: from one prompt, files are edited, tests run and a PR is opened. | search (third-party summary): [echai.ventures](https://echai.ventures/videos/anthropic-introducing-claude-code) |
| lazygit README | Embeds an MP4 (`github.com/user-attachments/...`) in a `<video>` tag directly under the tagline. Each demo is labelled by what it shows. | read: [README source](https://raw.githubusercontent.com/jesseduffield/lazygit/master/README.md) |
| atuin README | A repo-relative `demo.gif`, centred at 80 % width, with a one-line caption saying what is shown. | read: [README source](https://raw.githubusercontent.com/atuinsh/atuin/main/README.md) |
| charmbracelet/vhs | Terminal demos are scripted in `.tape` files, so a re-record is reproducible. `LoopOffset` makes the GIF's first frame an interesting one rather than an empty prompt. | read: [vhs README](https://raw.githubusercontent.com/charmbracelet/vhs/main/README.md) |

No usable breakdowns were found for the Zed, Cursor, Vercel v0, Supabase Launch Week or Codex launch clips, so
nothing here is attributed to them (unverified).

## Principles applied here

1. **The real UI fills the frame.** No mockups, no presenter. Every shot is recorded from the running app in a
   sandbox instance (`scripts/showcase/launch.mjs`). Following Raycast's teaser, the master crops into the panel
   that matters (board, lead box, sign-off) instead of showing the whole window all the time. Source: moonb.io (read).
2. **The payoff comes first.** The cut opens on the result: the board ticking tasks off while agents work. The
   logo appears only on the end card. Supporting data: Facebook/Nielsen mobile research found 47 % of a video ad's
   value is delivered in the first 3 seconds and 74 % in the first 10 (search:
   [Social Media Today](https://www.socialmediatoday.com/social-business/facebook-releases-new-report-maximizing-potential-your-video-assets),
   [MarTech](https://martech.org/facebook-releases-new-video-ad-features-including-automated-captions)). That data
   is from 2016–17 and is about ads, so treat it as direction, not as a number to quote.
3. **It has to work with the sound off.** On-screen text carries the story, and the voice-over lines are optional.
   - X has autoplayed timeline video muted since 2015; sound starts when the viewer taps in (search:
     [TechCrunch 2015](https://techcrunch.com/2015/06/16/twitter-now-autoplays-video-and-gifs)). That this is
     still the default today is unverified.
   - Digiday's often-quoted "85 % of Facebook video is watched without sound" (2016) comes from publishers' own
     numbers, not an audit (search: [Digiday](https://digiday.com/media/silent-world-facebook-video/)).
   - A 2019 Verizon Media / Publicis survey of 5,616 US adults found 69 % watch with the sound off in public, and
     80 % said captions make them more likely to finish a video (search:
     [3Play Media summary](https://www.3playmedia.com/blog/verizon-media-and-publicis-media-find-viewers-want-captions/)).
4. **Short labels over the UI, one idea per card.** This follows Warp's on-screen labels (read). The limit of about
   6 words per card, large enough to read on a phone, is a house rule (unverified as a measured optimum). Every card
   names something visible in that shot.
5. **Show the interaction, smoothly.** Screen-recording tools zoom toward clicks, smooth the cursor and add a click
   ripple, because a raw cursor is hard to follow at phone size (search:
   [Screen Studio review](https://daveswift.com/screen-studio/)). The capture script draws a smoothed cursor with a
   ripple. Zooms are crops, limited to 1.3x upscaling so text stays sharp (`--scale 1.5` allows tighter crops).
6. **One length per platform, cut from the same footage.**
   - **X:** the master is 45 s. X allows much longer uploads (140 s on non-Premium accounts; search:
     [X help](https://help.x.com/en/using-x/x-videos)), but a feature tour loses people well before that.
   - **LinkedIn:** recommends 15–30 s for ads (search: [LinkedIn help](https://www.linkedin.com/help/linkedin/answer/85306)),
     so the vertical cut is 30 s.
   - **README:** a 15 s loop.
   - **Show HN:** the guidelines say a demo video supplements something people can try; it doesn't replace it
     (search: [Show HN guidelines](https://news.ycombinator.com/showhn.html)). The 60–90 s outline is for the
     linked page, next to the download.
   - **Long versions:** add chapters, as Warp does (read).
7. **Aspect ratios.**
   - X takes 16:9, 1:1 and 9:16, at 30 fps in MP4/H.264 + AAC (search, vendor guides:
     [QuickFrame](https://quickframe.com/blog/twitter-video-ad-specs/)).
   - LinkedIn supports 9:16 up to 1080×1920, but serves 9:16 ads on mobile only and suggests 16:9 when one file has
     to cover desktop and mobile (search: [LinkedIn help](https://www.linkedin.com/help/linkedin/answer/85306),
     [Brandwatch](https://www.brandwatch.com/blog/linkedin-video-specs/)).
   - So: a 16:9 master and a 9:16 cut. The 9:16 cut gives a square-ish crop of the real UI its own band, with the
     text in bands above and below, rather than shrinking the 16:9 frame.
8. **README budget.**
   - GitHub's limits are 10 MB for images and GIFs, and 10 MB for video on free plans (100 MB on paid plans); MP4,
     MOV and WebM are accepted (read: [GitHub docs](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files)).
   - The hero GIF targets 6 MB or less (house rule, unverified as an optimum). If it can't fit, embed the MP4 the
     way lazygit does.
9. **A loop without a jump.**
   - Start on an interesting frame, as vhs does with `LoopOffset` (read).
   - End where the loop begins. The hero cut crossfades its last 0.6 s into its first frame. Both shots are of the
     same board, so the seam is a fade between near-identical frames. This approach is our own inference, not taken
     from a source.
10. **GIF encoding.**
    - Use two passes: `palettegen` then `paletteuse`.
    - `stats_mode=diff` spends the palette on what moves, which here is the UI that changes.
    - `diff_mode=rectangle` keeps dither noise out of static areas.
    - Bayer dithering compresses better than error diffusion.
    - The levers on size are fps and width (read: [pkh.me](https://blog.pkh.me/p/21-high-quality-gif-with-ffmpeg.html)).
    - The script steps down from 960 px / 15 fps until the GIF fits. gifski produces higher quality, but it is
      AGPL and an extra install (search: [docs.rs](https://docs.rs/crate/gifski/1.7.0)).
11. **End card.** Hold 4–5 s on the repo URL and how to get it. This is convention; no data was found
    (unverified).
12. **Honesty is part of the design.**
    - The terminals in the demo print scripted output. The cut says so in a small persistent tag and on the end
      card.
    - Every claim on a card is something the app does today and that the shot shows.
    - Nothing on screen imitates another product's UI.
