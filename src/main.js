import "./styles.css";

const legacyGameUrl =
  "/legacy-card-battle.html?v=20260616-card-assets";

document.querySelector("#app").innerHTML = `
  <main class="shell" aria-label="גני השמיים">
    <section class="game-stage">
      <iframe
        class="game-frame"
        title="גני השמיים - קרבות קלפים"
        src="${legacyGameUrl}"
        allow="fullscreen; autoplay"
      ></iframe>
    </section>
  </main>
`;
