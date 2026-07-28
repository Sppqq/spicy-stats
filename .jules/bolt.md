## 2024-07-28 - Debounce User Input Triggering DOM Operations
**Learning:** Synchronous searching on large datasets (especially nested arrays) connected to DOM re-rendering on every keypress blocks the main UI thread, resulting in extreme layout thrashing and input lag.
**Action:** Use a debounce on inputs where filtering and DOM updates are triggered, even if the dataset seems "small enough".
