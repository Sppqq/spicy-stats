## 2026-07-27 - Add ARIA labels and titles to icon-only Close buttons
**Learning:** Icon-only close buttons (using HTML entities like `&times;` or characters like `✕`) were missing critical accessibility attributes, making them inaccessible to screen readers and lacking tooltips for mouse users.
**Action:** Added `aria-label="Close"` and `title="Close"` to these buttons across all main HTML files (`admin.html`, `dashboard.html`, `user.html`) to improve overall usability and accessibility.
## 2024-05-14 - Semantic Buttons for Interactive Icons
**Learning:** Interactive icons implemented as `<span>` with `onclick` handlers are invisible to screen readers and keyboard navigation. Using a semantic `<button>` provides built-in accessibility benefits.
**Action:** When adding interactivity to icons, always use a semantic `<button type="button">` element with appropriate `aria-label` and `aria-pressed` (if applicable) attributes. Apply CSS resets (`background: transparent; border: none; padding: 0;`) to maintain visual appearance while gaining accessibility.
## 2026-07-30 - Accessible Interactive Rows
**Learning:** Interactive list items/rows implemented as `<div>` or `<tr>` with `onclick` handlers are inaccessible to keyboard users and screen readers.
**Action:** Add `tabindex="0"`, `role="link"` (or `role="button"`), and a `keydown` event listener for Enter/Space to ensure full accessibility for these interactive elements, rather than converting them to buttons which might break or require custom CSS.
## 2026-07-31 - Accessible Sortable Table Headers
**Learning:** Adding `role="button"` to sortable `<th>` elements overrides their native semantic role as table headers (`columnheader`), causing screen readers to lose table context.
**Action:** Keep the native `<th>` semantic by adding `tabindex="0"`, a `keydown` event listener for Enter/Space, explicit `role="columnheader"`, and dynamically updating the `aria-sort` attribute (`ascending`, `descending`, or `none`) to ensure full keyboard accessibility and screen reader support without breaking table semantics.
## 2026-08-01 - Global Escape Key to Close Modals
**Learning:** Modals that lack an `Escape` key close mechanism fail critical keyboard accessibility requirements, trapping keyboard-only users who must awkwardly tab through all modal contents to find the close button.
**Action:** Always implement a global `keydown` event listener for the `Escape` key that checks for currently open modals and properly triggers their respective close functions to ensure smooth, accessible navigation.
## 2026-08-02 - Accessible Tab Interfaces
**Learning:** Standard `<nav>` and `<button>` elements used for tab switching lack semantic meaning for screen readers, making it difficult for users to understand the interface structure and currently active tab.
**Action:** Always implement ARIA tab semantics: add `role="tablist"` to the container, `role="tab"` with `aria-controls` to the buttons, `role="tabpanel"` with `aria-labelledby` to the content panes, and dynamically toggle `aria-selected="true/false"` on the buttons using JavaScript when switching tabs.
## 2024-08-05 - Dynamic Form Feedback
**Learning:** Dynamic text changes via JavaScript (e.g. error/success messages on form submission) are invisible to screen readers without ARIA live regions.
**Action:** Always add `aria-live="polite"` and `aria-atomic="true"` to containers that act as feedback fields for asynchronous operations.
