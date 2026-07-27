## 2026-07-27 - Add ARIA labels and titles to icon-only Close buttons
**Learning:** Icon-only close buttons (using HTML entities like `&times;` or characters like `✕`) were missing critical accessibility attributes, making them inaccessible to screen readers and lacking tooltips for mouse users.
**Action:** Added `aria-label="Close"` and `title="Close"` to these buttons across all main HTML files (`admin.html`, `dashboard.html`, `user.html`) to improve overall usability and accessibility.
