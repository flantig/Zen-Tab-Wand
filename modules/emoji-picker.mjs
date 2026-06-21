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
  ["Symbols", "⭐", "🌟", "✨", "💫", "🔥", "💎", "🎲", "🎯", "🧭", "🧿", "♻️", "🔁", "🔄", "➕", "➖", "➗", "✳️", "❇️", "💠", "🔷", "🔶", "🔰", "〽️", "⚜️", "🔱", "🌀", "💤", "🧶", "🪩", "🗜️"],
];

const EMOJI_NAMES = new Map([
  ["💼", "briefcase"],
  ["📌", "pushpin"],
  ["📊", "bar chart"],
  ["📈", "chart with upwards trend"],
  ["📉", "chart with downwards trend"],
  ["🧾", "receipt"],
  ["📝", "memo"],
  ["📅", "calendar"],
  ["📬", "open mailbox with raised flag"],
  ["✅", "white heavy check mark"],
  ["⚙️", "gear"],
  ["🔒", "lock"],
  ["📋", "clipboard"],
  ["📎", "paperclip"],
  ["🗂️", "card index dividers"],
  ["📁", "file folder"],
  ["📇", "card index"],
  ["📑", "bookmark tabs"],
  ["🗓️", "spiral calendar pad"],
  ["⏰", "alarm clock"],
  ["⌛", "hourglass"],
  ["📣", "cheering megaphone"],
  ["🏷️", "label"],
  ["🔖", "bookmark"],
  ["✉️", "envelope"],
  ["🕒", "clock face three oclock"],
  ["📤", "outbox tray"],
  ["💻", "personal computer"],
  ["🧑‍💻", "adult personal computer"],
  ["⌨️", "keyboard"],
  ["🛠️", "hammer and wrench"],
  ["🐛", "bug"],
  ["🚀", "rocket"],
  ["📦", "package"],
  ["🌐", "globe with meridians"],
  ["🔧", "wrench"],
  ["🧪", "test tube"],
  ["📚", "books"],
  ["🔍", "left pointing magnifying glass"],
  ["🖥️", "desktop computer"],
  ["🧰", "toolbox"],
  ["🧱", "brick"],
  ["🗃️", "card file box"],
  ["🧮", "abacus"],
  ["📟", "pager"],
  ["🔌", "electric plug"],
  ["💾", "floppy disk"],
  ["💿", "optical disc"],
  ["🧵", "spool of thread"],
  ["🔬", "microscope"],
  ["🧲", "magnet"],
  ["🕹️", "joystick"],
  ["📡", "satellite antenna"],
  ["🧑‍🔬", "adult microscope"],
  ["▶️", "black right pointing triangle"],
  ["🎬", "clapper board"],
  ["🎧", "headphone"],
  ["🎵", "musical note"],
  ["📺", "television"],
  ["📹", "video camera"],
  ["📷", "camera"],
  ["🎮", "video game"],
  ["🍿", "popcorn"],
  ["📻", "radio"],
  ["🎙️", "studio microphone"],
  ["⭐", "white medium star"],
  ["⏯️", "black right pointing triangle with double vertical bar"],
  ["⏭️", "black right pointing double triangle with vertical bar"],
  ["⏮️", "black left pointing double triangle with vertical bar"],
  ["🎞️", "film frames"],
  ["🎨", "artist palette"],
  ["🖼️", "frame with picture"],
  ["🖌️", "lower left paintbrush"],
  ["🎤", "microphone"],
  ["🎼", "musical score"],
  ["🎹", "musical keyboard"],
  ["🥁", "drum with drumsticks"],
  ["🎸", "guitar"],
  ["🏆", "trophy"],
  ["📽️", "film projector"],
  ["🔴", "large red circle"],
  ["🏠", "house building"],
  ["🛒", "shopping trolley"],
  ["💳", "credit card"],
  ["🏦", "bank"],
  ["✈️", "airplane"],
  ["🚗", "automobile"],
  ["🍽️", "fork and knife with plate"],
  ["🏥", "hospital"],
  ["💪", "flexed biceps"],
  ["🎁", "wrapped present"],
  ["❤️", "heavy black heart"],
  ["🌱", "seedling"],
  ["🧳", "luggage"],
  ["🧭", "compass"],
  ["🗺️", "world map"],
  ["🏨", "hotel"],
  ["⛽", "fuel pump"],
  ["🚆", "train"],
  ["🚲", "bicycle"],
  ["☕", "hot beverage"],
  ["🍎", "red apple"],
  ["🥗", "green salad"],
  ["🧘", "person in lotus position"],
  ["🛌", "sleeping accommodation"],
  ["🎯", "direct hit"],
  ["🌤️", "white sun with small cloud"],
  ["🧹", "broom"],
  ["✨", "sparkles"],
  ["🤖", "robot face"],
  ["🧠", "brain"],
  ["💬", "speech balloon"],
  ["🔮", "crystal ball"],
  ["⚡", "high voltage sign"],
  ["🪄", "magic wand"],
  ["🧩", "jigsaw puzzle piece"],
  ["🛰️", "satellite"],
  ["🧬", "dna double helix"],
  ["👁️", "eye"],
  ["💡", "electric light bulb"],
  ["🌀", "cyclone"],
  ["🌟", "glowing star"],
  ["🔊", "speaker with three sound waves"],
  ["🎛️", "control knobs"],
  ["🧿", "nazar amulet"],
  ["📐", "triangular ruler"],
  ["🔗", "link symbol"],
  ["🧫", "petri dish"],
  ["⚗️", "alembic"],
  ["📍", "round pushpin"],
  ["🪫", "low battery"],
  ["🔋", "battery"],
  ["🖇️", "linked paperclips"],
  ["🪬", "hamsa"],
  ["💰", "money bag"],
  ["💵", "banknote with dollar sign"],
  ["💸", "money with wings"],
  ["💲", "heavy dollar sign"],
  ["🏧", "automated teller machine"],
  ["🪙", "coin"],
  ["🛍️", "shopping bags"],
  ["🧺", "basket"],
  ["💹", "chart with upwards trend and yen sign"],
  ["💱", "currency exchange"],
  ["🧑‍💼", "adult briefcase"],
  ["🏪", "convenience store"],
  ["🏬", "department store"],
  ["🧴", "lotion bottle"],
  ["🧻", "roll of paper"],
  ["🎟️", "admission tickets"],
  ["🧧", "red gift envelope"],
  ["📨", "incoming envelope"],
  ["📩", "envelope with downwards arrow above"],
  ["📧", "e mail symbol"],
  ["📥", "inbox tray"],
  ["📞", "telephone receiver"],
  ["📱", "mobile phone"],
  ["☎️", "black telephone"],
  ["📢", "public address loudspeaker"],
  ["🔔", "bell"],
  ["🔕", "bell with cancellation stroke"],
  ["📮", "postbox"],
  ["🗣️", "speaking head in silhouette"],
  ["👥", "busts in silhouette"],
  ["🫂", "people hugging"],
  ["🤝", "handshake"],
  ["🙋", "happy person raising one hand"],
  ["🙌", "person raising both hands in celebration"],
  ["👋", "waving hand sign"],
  ["✍️", "writing hand"],
  ["🗯️", "right anger bubble"],
  ["💭", "thought balloon"],
  ["📲", "mobile phone with rightwards arrow at left"],
  ["📶", "antenna with bars"],
  ["🛜", "wireless"],
  ["☑️", "ballot box with check"],
  ["✔️", "heavy check mark"],
  ["❌", "cross mark"],
  ["⚠️", "warning sign"],
  ["🚫", "no entry sign"],
  ["⛔", "no entry"],
  ["🟠", "large orange circle"],
  ["🟡", "large yellow circle"],
  ["🟢", "large green circle"],
  ["🔵", "large blue circle"],
  ["🟣", "large purple circle"],
  ["⚪", "medium white circle"],
  ["⚫", "medium black circle"],
  ["⬆️", "upwards black arrow"],
  ["⬇️", "downwards black arrow"],
  ["➡️", "black rightwards arrow"],
  ["⬅️", "leftwards black arrow"],
  ["🔺", "up pointing red triangle"],
  ["🔻", "down pointing red triangle"],
  ["🔸", "small orange diamond"],
  ["🔹", "small blue diamond"],
  ["🟩", "large green square"],
  ["🟥", "large red square"],
  ["🟦", "large blue square"],
  ["⬜", "white large square"],
  ["🏢", "office building"],
  ["🏛️", "classical building"],
  ["🏫", "school"],
  ["🏭", "factory"],
  ["🏗️", "building construction"],
  ["🏡", "house with garden"],
  ["⛰️", "mountain"],
  ["🌆", "cityscape at dusk"],
  ["🌃", "night with stars"],
  ["🛣️", "motorway"],
  ["🛤️", "railway track"],
  ["🛫", "airplane departure"],
  ["🛬", "airplane arriving"],
  ["🚢", "ship"],
  ["🏙️", "cityscape"],
  ["🏕️", "camping"],
  ["🏖️", "beach with umbrella"],
  ["🏟️", "stadium"],
  ["🗽", "statue of liberty"],
  ["🕌", "mosque"],
  ["⛩️", "shinto shrine"],
  ["🛎️", "bellhop bell"],
  ["🚏", "bus stop"],
  ["🔨", "hammer"],
  ["🪛", "screwdriver"],
  ["🧯", "fire extinguisher"],
  ["🔦", "electric torch"],
  ["🔑", "key"],
  ["🗝️", "old key"],
  ["🪜", "ladder"],
  ["⚖️", "scales"],
  ["🧷", "safety pin"],
  ["✂️", "black scissors"],
  ["📏", "straight ruler"],
  ["🖊️", "lower left ballpoint pen"],
  ["✏️", "pencil"],
  ["🖍️", "lower left crayon"],
  ["🧽", "sponge"],
  ["🪣", "bucket"],
  ["🪒", "razor"],
  ["🔩", "nut and bolt"],
  ["💫", "dizzy symbol"],
  ["🔥", "fire"],
  ["💎", "gem stone"],
  ["🎲", "game die"],
  ["♻️", "black universal recycling symbol"],
  ["🔁", "clockwise rightwards and leftwards open circle arrows"],
  ["🔄", "anticlockwise downwards and upwards open circle arrows"],
  ["➕", "heavy plus sign"],
  ["➖", "heavy minus sign"],
  ["➗", "heavy division sign"],
  ["✳️", "eight spoked asterisk"],
  ["❇️", "sparkle"],
  ["💠", "diamond shape with a dot inside"],
  ["🔷", "large blue diamond"],
  ["🔶", "large orange diamond"],
  ["🔰", "japanese symbol for beginner"],
  ["〽️", "part alternation mark"],
  ["⚜️", "fleur de lis"],
  ["🔱", "trident emblem"],
  ["💤", "sleeping symbol"],
  ["🧶", "ball of yarn"],
  ["🪩", "mirror ball"],
  ["🗜️", "compression"],
]);

const ALL_EMOJIS = EMOJI_SETS.flatMap(([groupName, ...items]) =>
  items.map((emoji) => ({
    emoji,
    group: groupName.toLowerCase(),
    name: EMOJI_NAMES.get(emoji) || "",
  }))
);
const PAGE_SIZE = 12;

const matchesQuery = ({ emoji, group, name }, query) =>
  !query || emoji.includes(query) || group.includes(query) || name.includes(query);

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
  const searchRow = h("div", { class: "zao-emoji-search-row" });
  const current = h("button", { class: "zao-emoji-current" });
  current.type = "button";
  const search = h("input", { class: "zao-emoji-search" });
  search.type = "text";
  search.placeholder = "Search emoji";
  search.value = "";
  search.spellcheck = false;
  searchRow.appendChild(current);
  searchRow.appendChild(search);
  pop.appendChild(searchRow);

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
    renderCurrent();
  };

  function renderCurrent() {
    const icon = typeof rule.icon === "string" ? rule.icon.trim() : "";
    current.replaceChildren();
    current.classList.toggle("zao-emoji-current-empty", !icon);
    current.title = icon ? "Clear icon" : "No icon";
    current.setAttribute("aria-label", icon ? "Clear icon" : "No icon set");
    if (icon) current.appendChild(h("span", { class: "zao-emoji-glyph", text: icon }));
  }

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
      const btn = h("button", { class: "zao-emoji-choice" });
      btn.type = "button";
      btn.title = item.name || item.group;
      btn.setAttribute("aria-label", item.name ? `${item.emoji} ${item.name}` : item.emoji);
      btn.appendChild(h("span", { class: "zao-emoji-glyph", text: item.emoji }));
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
  current.addEventListener("click", (e) => {
    e.stopPropagation();
    if (rule.icon) commit("");
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

  renderCurrent();
  renderGrid();
  setTimeout(() => {
    document.addEventListener("mousedown", closeIfOutside, true);
    document.addEventListener("keydown", onKey, true);
    search.focus();
    search.select();
  }, 0);
};
