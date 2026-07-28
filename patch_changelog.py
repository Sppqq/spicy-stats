import re

files = ['dashboard.html', 'user.html', 'admin.html']

for file in files:
    with open(file, 'r') as f:
        content = f.read()

    # Re-indent the injected entry properly
    content = content.replace('                                <div style="margin-bottom: 16px;">', '                <div style="margin-bottom: 16px;">')
    content = content.replace('<div style="margin-bottom: 16px;">\n                    <strong style="color: var(--ink);">v1.2.11 (2026-07-28)</strong>', '                <div style="margin-bottom: 16px;">\n                    <strong style="color: var(--ink);">v1.2.11 (2026-07-28)</strong>')

    with open(file, 'w') as f:
        f.write(content)
