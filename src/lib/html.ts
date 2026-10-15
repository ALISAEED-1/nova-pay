export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Minimal mobile-friendly page shell shared by the server-rendered pages. */
export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light; --ink: #1a1a1f; --muted: #6b6b76; --line: #e4e4ea; --brand: #4f46e5; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
         color: var(--ink); background: #f4f4f7; }
  main { max-width: 420px; margin: 0 auto; padding: 24px 16px 40px; }
  .card { background: #fff; border: 1px solid var(--line); border-radius: 16px; padding: 24px; }
  .badge { display: inline-block; font-size: 12px; font-weight: 700; letter-spacing: .04em;
           text-transform: uppercase; color: #92400e; background: #fef3c7; border-radius: 999px; padding: 2px 10px; }
  h1 { font-size: 20px; margin: 12px 0 4px; }
  .muted { color: var(--muted); font-size: 14px; }
  .amount { font-size: 36px; font-weight: 800; margin: 16px 0; }
  button { width: 100%; font: inherit; font-weight: 600; padding: 14px; border-radius: 12px;
           border: 1px solid var(--line); background: #fff; color: var(--ink); margin-top: 10px; cursor: pointer; }
  button.primary { background: var(--brand); border-color: var(--brand); color: #fff; }
  button.danger { color: #b91c1c; }
  .note { margin-top: 20px; font-size: 13px; color: var(--muted); }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}
