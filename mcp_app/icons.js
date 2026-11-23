const shapes = {
  back: '<path d="m14 6-6 6 6 6"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8h.01"/>',
  refresh: '<path d="M20 10a8 8 0 1 0-2.3 7.7M20 5v5h-5"/>',
  dot: '<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  think: '<path d="M9 18h6m-5 3h4M9 15a5 5 0 1 1 6 0"/>',
  terminal: '<path d="m4 7 5 5-5 5m8 0h8"/>',
  files: '<path d="M9 7H5v13h11v-4m-7-1V4h7l4 4v7Z"/>',
  chat: '<path d="M4 5h16v11H9l-5 4V5Zm4 5h8m-8 3h5"/>',
  inbox: '<path d="M4 12 7 5h10l3 7v7H4Zm0 0h5l1 3h4l1-3h5"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  file: '<path d="M6 3h8l4 4v14H6Zm8 0v5h4"/>',
  link: '<path d="M13 5h6v6m0-6-8 8m6 0v6H5V7h6"/>',
};

export function icon(name, className = "") {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  for (const [key, value] of Object.entries({
    class: `icon ${className}`, viewBox: "0 0 24 24", width: 14, height: 14,
    fill: "none", stroke: "currentColor", "stroke-width": 1.75,
    "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true",
  })) svg.setAttribute(key, value);
  // Shapes are fixed source literals; never parse transcript content as SVG.
  for (const shape of shapes[name].matchAll(/<(\w+) ([^>]+)\/>/g)) {
    const child = document.createElementNS(ns, shape[1]);
    for (const [, key, value] of shape[2].matchAll(/([\w-]+)="([^"]*)"/g)) child.setAttribute(key, value);
    svg.append(child);
  }
  return svg;
}
