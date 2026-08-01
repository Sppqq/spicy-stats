# Original User Request

## Initial Request — 2026-07-12T09:03:58Z

Translate the spicy-stats dashboard and profile to English, style zero-value stats as neutral grey, and add interactive track statistics modals to the profile page.

Working directory: c:\Users\vsevo\Desktop\spicy-stats
Integrity mode: development

## Requirements

### R1. English Translation
All user-facing text, error messages, and dynamic notifications must be in English. This includes:
- Frontend files (`dashboard.html` and `user.html`).
- Backend API messages (`cloudflare_pages/worker.js`) such as rate-limit notices, username validation errors, "user not found" messages, and the default track fallback name (change "Скрыто" to "Hidden").

### R2. Muted Styling for Zero Values
Zero values (0) must be styled in neutral grey (`var(--muted)`) instead of active green or coral/red:
- On the dashboard: user growth, 7d tracks growth, and the global tracks tracked card (if 0).
- On the profile page: 24h growth, total track count card (if 0), and individual track growth values.

### R3. Clickable Tracks with History Modals
Individual tracks listed on the profile page must be clickable, displaying a modal popup with their historical statistics:
- Add a visual cursor pointer to tracks in the list.
- On click, open a modal displaying the track title, artist, current views, 24h growth, and an SVG line chart of view history.
- The chart should utilize a blue theme (`var(--blue)`) and include interactive tooltips on mouse hover.
- Fetch history data from the `/api/track-history` endpoint.

## Acceptance Criteria

### Translation & UI Language
- [ ] No Russian text or labels are visible to the user on the dashboard or profile pages.
- [ ] The fallback name for empty song titles is updated from "Скрыто" to "Hidden".
- [ ] All error alerts and queue messages are in English.

### Zero Value Styling
- [ ] Dashboard 24h views growth card displays grey text color instead of green when growth is 0.
- [ ] Dashboard Tracks tracked card displays grey background if total tracks are 0.
- [ ] Profile page 24h views growth card displays grey background and grey value if growth is 0.
- [ ] Profile page Tracks card displays grey background and grey value if total tracks are 0.
- [ ] Profile page top tracks list displays track growth as `0` in grey instead of `+0` in green when growth is 0.

### Track History Popups
- [ ] Clicking a track row in the profile page opens a modal window.
- [ ] The modal displays the track's name, artist, views, 24h growth, and an SVG line chart of its view count history.
- [ ] The chart uses a blue fill/stroke (`var(--blue)`) instead of red/coral.
- [ ] Hovering over the chart shows a tooltip with date and view count.
- [ ] The modal can be closed via a close button or by clicking on the background.
