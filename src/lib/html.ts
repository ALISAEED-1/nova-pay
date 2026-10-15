export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Mobile page shell for the server-rendered pages (the test checkout and the
 * return page). They open inside the Nova Cinema app, so they use its theme:
 * the colours mirror the app's `AppColors`, the radii its `AppRadius`, and the
 * typeface is the app's Outfit.
 */
export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#050608">
<title>${escapeHtml(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;900&display=swap" rel="stylesheet">
<style>
  :root {
    color-scheme: dark;
    --background: #050608;
    --surface: #0E1013;
    --surface-elevated: #161A1F;
    --surface-highlight: #1F242B;
    --primary: #E50914;
    --primary-pressed: #B20710;
    --gold: #E8B44C;
    --text: #F4F4F5;
    --text-secondary: #A1A1AA;
    --text-muted: #6B6F76;
    --border: rgba(255, 255, 255, .08);
    --border-strong: rgba(255, 255, 255, .16);
    --error: #FF6B6B;
    --radius: 10px;
    --radius-lg: 14px;
  }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body {
    margin: 0;
    min-height: 100vh;
    font: 16px/1.5 Outfit, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: var(--text);
    background: radial-gradient(120% 60% at 50% 0%, #1a0608 0%, var(--background) 60%) fixed var(--background);
  }
  main { max-width: 440px; margin: 0 auto; padding: 28px 20px 40px; }
  .brand { font-weight: 900; font-size: 22px; letter-spacing: -.02em; color: var(--primary); margin: 0 0 20px; }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 24px 20px;
  }
  .badge {
    display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: .08em;
    text-transform: uppercase; color: var(--gold);
    border: 1px solid rgba(232, 180, 76, .4); background: rgba(232, 180, 76, .12);
    border-radius: 999px; padding: 3px 10px;
  }
  h1 { font-size: 22px; font-weight: 700; margin: 14px 0 2px; }
  .muted { color: var(--text-secondary); font-size: 14px; }
  .amount { font-size: 40px; font-weight: 700; letter-spacing: -.01em; margin: 14px 0 6px; }
  .section { margin-top: 22px; font-size: 12px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--text-muted); }
  form { margin: 0; }
  button {
    width: 100%; margin-top: 10px; padding: 14px 16px; cursor: pointer; text-align: left;
    font: inherit; font-weight: 600; color: var(--text);
    background: rgba(255, 255, 255, .08);
    border: 1px solid var(--border); border-radius: var(--radius);
    transition: background .18s ease, transform .18s ease;
  }
  button:active { transform: scale(.985); background: rgba(255, 255, 255, .12); }
  button.primary { background: var(--primary); border-color: var(--primary); color: #fff; }
  button.primary:active { background: var(--primary-pressed); }
  button.danger { background: transparent; border-color: rgba(255, 107, 107, .35); color: var(--error); text-align: center; }
  button.plain { background: transparent; border-color: transparent; color: var(--text-secondary); text-align: center; }
  button .hint { display: block; font-size: 13px; font-weight: 400; color: var(--text-secondary); margin-top: 2px; }
  button.primary .hint { color: rgba(255, 255, 255, .8); }
  .note { margin: 20px 0 0; font-size: 13px; line-height: 1.55; color: var(--text-muted); }
  .center { text-align: center; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}
