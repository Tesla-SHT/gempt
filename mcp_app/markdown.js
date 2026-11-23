import { decodeHTML } from "entities";
import { lexer } from "marked";
import { icon } from "./icons.js";
import { linkTarget } from "./live-state.js";

function element(tag, value = "", className = "") {
  const node = document.createElement(tag);
  if (value) node.textContent = value;
  if (className) node.className = className;
  return node;
}

function tableRow(cells, header, options) {
  const row = element("tr");
  for (const cell of cells) {
    const entry = element(header ? "th" : "td");
    if (header) entry.setAttribute("scope", "col");
    if (cell.align) entry.dataset.align = cell.align;
    appendTokens(entry, cell.tokens, options);
    row.append(entry);
  }
  return row;
}

function codeBlock({ lang, text }, { copy }) {
  const language = lang?.trim().split(/\s+/, 1)[0] || "纯文本";
  const box = element("div", "", "code-block");
  const header = element("div", "", "code-head");
  const button = element("button", "", "copy-btn");
  button.type = "button";
  button.append(icon("copy"), "复制");
  button.setAttribute("aria-label", "复制代码");
  button.addEventListener("click", () => void copy(text));
  header.append(element("span", language), button);
  const pre = element("pre");
  pre.tabIndex = 0;
  const code = element("code");
  if (/^(diff|patch)$/i.test(language)) {
    for (const [index, line] of text.split("\n").entries()) {
      if (index) code.append("\n");
      const type = line.startsWith("+") ? "add" : line.startsWith("-") ? "remove" : line.startsWith("@@") ? "hunk" : "";
      code.append(type ? element("span", line, `diff-${type}`) : line);
    }
  } else code.textContent = text;
  pre.append(code);
  box.append(header, pre);
  return box;
}

function appendTokens(parent, tokens, options) {
  for (const token of tokens) {
    const { type, text, tokens: children } = token;
    if (type === "space") continue;
    if (type === "html" || type === "escape" || type === "image") {
      parent.append(type === "image" ? decodeHTML(text) : text);
      continue;
    }
    if (type === "code") {
      parent.append(codeBlock(token, options));
      continue;
    }
    if (type === "table") {
      const wrap = element("div", "", "md-table");
      wrap.tabIndex = 0;
      wrap.setAttribute("role", "region");
      wrap.setAttribute("aria-label", "表格");
      const table = element("table");
      table.createTHead().append(tableRow(token.header, true, options));
      table.createTBody().append(...token.rows.map((row) => tableRow(row, false, options)));
      wrap.append(table);
      parent.append(wrap);
      continue;
    }
    if (type === "list") {
      const list = element(token.ordered ? "ol" : "ul");
      if (token.ordered && token.start !== 1) list.start = token.start;
      for (const item of token.items) {
        const li = element("li");
        appendTokens(li, item.tokens, options);
        list.append(li);
      }
      parent.append(list);
      continue;
    }
    if (type === "checkbox") {
      const check = element("input");
      check.type = "checkbox";
      check.checked = token.checked;
      check.disabled = true;
      check.setAttribute("aria-label", token.checked ? "已完成" : "未完成");
      parent.append(check, " ");
      continue;
    }
    if (type === "link") {
      const target = linkTarget(decodeHTML(token.href), options.cwd, { fileUris: options.fileUris });
      if (!target) {
        appendTokens(parent, children, options);
        continue;
      }
      const link = element("button", "", "md-link");
      link.type = "button";
      link.setAttribute("role", "link");
      link.title = target.value;
      appendTokens(link, children, options);
      link.addEventListener("click", () => void options.openLink(target));
      parent.append(link);
      continue;
    }
    const tag = type === "heading" ? `h${token.depth}` : {
      paragraph: "p", blockquote: "blockquote", strong: "strong", em: "em", del: "del",
      codespan: "code", br: "br", hr: "hr",
    }[type];
    const node = tag ? element(tag) : parent;
    if (children) appendTokens(node, children, options);
    else if (text) node.append(type === "codespan" ? text : decodeHTML(text));
    if (tag) parent.append(node);
  }
}

export function renderMarkdown(text, options) {
  const root = element("div", "", "md");
  appendTokens(root, lexer(String(text || ""), { gfm: true }), options);
  return root;
}
