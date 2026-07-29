## 2026-07-27 - Add ARIA labels and titles to icon-only Close buttons
**Learning:** Icon-only close buttons (using HTML entities like `&times;` or characters like `✕`) were missing critical accessibility attributes, making them inaccessible to screen readers and lacking tooltips for mouse users.
**Action:** Added `aria-label="Close"` and `title="Close"` to these buttons across all main HTML files (`admin.html`, `dashboard.html`, `user.html`) to improve overall usability and accessibility.
## 2024-05-14 - Semantic Buttons for Interactive Icons
**Learning:** Interactive icons implemented as `<span>` with `onclick` handlers are invisible to screen readers and keyboard navigation. Using a semantic `<button>` provides built-in accessibility benefits.
**Action:** When adding interactivity to icons, always use a semantic `<button type="button">` element with appropriate `aria-label` and `aria-pressed` (if applicable) attributes. Apply CSS resets (`background: transparent; border: none; padding: 0;`) to maintain visual appearance while gaining accessibility.
