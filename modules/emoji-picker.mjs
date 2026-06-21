// Zen Tab Wand — tiny no-dependency emoji picker for rule icons.

import { CONFIG, h } from "./config.mjs";

const EMOJI_SETS = [
  ["Work", "💼", "📌", "📊", "📈", "📉", "🧾", "📝", "📅", "📬", "✅", "⚙️", "🔒", "📋", "📎", "🗂️", "📁", "📇", "📑", "🗓️", "⏰", "⌛", "📣", "🏷️", "🔖", "✉️", "🕒", "📤"],
  ["Dev", "💻", "🧑‍💻", "⌨️", "🛠️", "🐛", "🚀", "📦", "🌐", "🔧", "🧪", "📚", "🔍", "🖥️", "🧰", "🧱", "🗃️", "🧮", "📟", "🔌", "💾", "💿", "🧵", "🔬", "🧲", "🕹️", "📡", "🧑‍🔬"],
  ["Media", "▶️", "🎬", "🎧", "🎵", "📺", "📹", "📷", "🎮", "🍿", "📻", "🎙️", "⭐", "⏯️", "⏭️", "⏮️", "🎞️", "🎨", "🖼️", "🖌️", "🎤", "🎼", "🎹", "🥁", "🎸", "🏆", "📽️", "🔴"],
  ["Life", "🏠", "🛒", "💳", "🏦", "✈️", "🚗", "🍽️", "🏥", "💪", "🎁", "❤️", "🌱", "🧳", "🧭", "🗺️", "🏨", "⛽", "🚆", "🚲", "☕", "🍎", "🥗", "🧘", "🛌", "🎯", "🌤️", "🧹"],
  ["AI", "✨", "🤖", "🧠", "💬", "🔮", "⚡", "🪄", "🧩", "📡", "🛰️", "🧬", "👁️", "💡", "🌀", "🌟", "🔊", "🎛️", "🧿", "📐", "🔗", "🧫", "⚗️", "📍", "🪫", "🔋", "🖇️", "🪬"],
  ["Finance", "💰", "💵", "💸", "💲", "🧮", "📈", "📉", "🏦", "🏧", "🧾", "💳", "🪙", "📊", "🛍️", "🏷️", "📦", "🧺", "🛒", "💹", "💱", "🧑‍💼", "🏪", "🏬", "🧴", "🧻", "🎟️", "🧧"],
  ["Comms", "💬", "📨", "📩", "📧", "📤", "📥", "📞", "📱", "☎️", "📢", "📣", "🔔", "🔕", "📮", "🗣️", "👥", "🫂", "🤝", "🙋", "🙌", "👋", "✍️", "🗯️", "💭", "📲", "📶", "🛜"],
  ["Status", "✅", "☑️", "✔️", "❌", "⚠️", "🚫", "⛔", "🔴", "🟠", "🟡", "🟢", "🔵", "🟣", "⚪", "⚫", "⬆️", "⬇️", "➡️", "⬅️", "🔺", "🔻", "🔸", "🔹", "🟩", "🟥", "🟦", "⬜"],
  ["Places", "🌐", "🏢", "🏛️", "🏫", "🏥", "🏭", "🏗️", "🏪", "🏬", "🏡", "⛰️", "🌆", "🌃", "🛣️", "🛤️", "🛫", "🛬", "🚢", "🏙️", "🏕️", "🏖️", "🏟️", "🗽", "🕌", "⛩️", "🛎️", "🚏"],
  ["Tools", "🔧", "🔨", "🪛", "🧰", "🧲", "🧯", "🔦", "🔑", "🗝️", "🪜", "⚖️", "🧷", "✂️", "📏", "📐", "🖊️", "✏️", "🖍️", "🧽", "🪣", "🧴", "🪒", "🪄", "🔩", "⚙️", "🧪", "🧬"],
  ["Symbols", "⭐", "🌟", "✨", "💫", "🔥", "💎", "🎲", "🎯", "🧭", "🧿", "♻️", "🔁", "🔄", "➕", "➖", "➗", "✳️", "❇️", "💠", "🔷", "🔶", "🔰", "〽️", "⚜️", "🔱", "🌀", "💤"],
];

const ALL_EMOJIS = EMOJI_SETS.flatMap(([name, ...items]) =>
  items.map((emoji) => ({ emoji, group: name.toLowerCase() }))
);
const PAGE_SIZE = 9;

const matchesQuery = ({ emoji, group }, query) =>
  !query || emoji.includes(query) || group.includes(query);

export const updateIconButtonAppearance = (button, icon) => {
  const value = typeof icon === "string" ? icon.trim() : "";
  button.textContent = value || "◇";
  button.classList.toggle("zao-icon-empty", !value);
  button.title = value ? `Icon: ${value}` : "Pick an icon";
  button.setAttribute("aria-label", value ? `Change icon ${value}` : "Pick an icon");
};

export const openEmojiPopover = (rule, anchor, onChange) => {
  document.querySelectorAll(".zao-emoji-popover").forEach((p) => p.remove());

  const pop = h("div", { class: "zao-emoji-popover" });
  const search = h("input", { class: "zao-emoji-search" });
  search.type = "text";
  search.placeholder = "Search emoji";
  search.value = "";
  search.spellcheck = false;
  pop.appendChild(search);

  const grid = h("div", { class: "zao-emoji-grid" });
  pop.appendChild(grid);

  const pager = h("div", { class: "zao-emoji-pager" });
  const prev = h("button", { class: "zao-emoji-action", text: "Prev" });
  prev.type = "button";
  const pageLabel = h("span", { class: "zao-emoji-page" });
  const next = h("button", { class: "zao-emoji-action", text: "Next" });
  next.type = "button";
  pager.appendChild(prev);
  pager.appendChild(pageLabel);
  pager.appendChild(next);
  pop.appendChild(pager);

  const commit = (value) => {
    const icon = String(value || "").trim().slice(0, 12);
    if (icon) rule.icon = icon;
    else delete rule.icon;
    onChange();
    updateIconButtonAppearance(anchor, rule.icon);
  };

  let page = 0;
  const filteredItems = () => {
    const query = search.value.trim().toLocaleLowerCase();
    return ALL_EMOJIS.filter((entry) => matchesQuery(entry, query));
  };

  const renderGrid = () => {
    const items = filteredItems();
    const pageCount = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    page = Math.min(page, pageCount - 1);
    const start = page * PAGE_SIZE;
    grid.replaceChildren();
    for (const item of items.slice(start, start + PAGE_SIZE)) {
      const btn = h("button", { class: "zao-emoji-choice", text: item.emoji });
      btn.type = "button";
      btn.title = item.group;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        commit(item.emoji);
        pop.remove();
        cleanup();
      });
      grid.appendChild(btn);
    }
    pageLabel.textContent = `${page + 1}/${pageCount}`;
    prev.disabled = page === 0;
    next.disabled = page >= pageCount - 1;
    pager.hidden = items.length <= PAGE_SIZE;
  };

  prev.addEventListener("click", (e) => {
    e.stopPropagation();
    page = Math.max(0, page - 1);
    renderGrid();
  });
  next.addEventListener("click", (e) => {
    e.stopPropagation();
    page += 1;
    renderGrid();
  });
  search.addEventListener("input", () => {
    page = 0;
    renderGrid();
  });
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      grid.querySelector(".zao-emoji-choice")?.click();
    } else if (e.key === "Escape") {
      e.preventDefault();
      pop.remove();
      cleanup();
    }
  });
  pop.addEventListener("click", (e) => e.stopPropagation());

  const dialog = anchor.closest(".sineItemPreferenceDialog") || document.body;
  dialog.appendChild(pop);

  const r = anchor.getBoundingClientRect();
  const popRect = pop.getBoundingClientRect();
  const gap = CONFIG.POPOVER_GAP_PX;
  const maxLeft = Math.max(gap, window.innerWidth - popRect.width - gap);
  pop.style.left = `${Math.min(Math.max(gap, r.left), maxLeft)}px`;
  const aboveTop = r.top - popRect.height - gap;
  pop.style.top = `${aboveTop >= gap ? aboveTop : r.bottom + gap}px`;

  const closeIfOutside = (e) => {
    if (!pop.contains(e.target) && e.target !== anchor) {
      pop.remove();
      cleanup();
    }
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      pop.remove();
      cleanup();
    }
  };
  const cleanup = () => {
    document.removeEventListener("mousedown", closeIfOutside, true);
    document.removeEventListener("keydown", onKey, true);
  };

  renderGrid();
  setTimeout(() => {
    document.addEventListener("mousedown", closeIfOutside, true);
    document.addEventListener("keydown", onKey, true);
    search.focus();
    search.select();
  }, 0);
};
