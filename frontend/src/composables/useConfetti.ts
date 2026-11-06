import confetti from "canvas-confetti";

const COLORS = ["#ff4fa3", "#ffb547", "#7c5cff", "#2ee6c5", "#ffffff", "#ff6b6b"];

let emojiShapes: confetti.Shape[] | undefined;

// Building text shapes rasterises each emoji, so do it once on first use.
function getEmojiShapes() {
  emojiShapes ??= ["🎉", "🥳", "🎊", "✨", "🎈"].map((text) => confetti.shapeFromText({ text, scalar: 2.4 }));
  return emojiShapes;
}

export function useConfetti() {
  /** Fires a full celebration from `origin` (normalised 0..1 viewport coordinates). */
  function celebrate(origin: { x: number; y: number }) {
    // Main burst out of the button.
    confetti({ particleCount: 140, spread: 110, startVelocity: 48, origin, colors: COLORS, ticks: 260 });
    confetti({ particleCount: 60, spread: 360, startVelocity: 26, origin, colors: COLORS, shapes: ["star"], scalar: 1.2 });

    // Party favors: emoji tossed up and out.
    confetti({ particleCount: 18, spread: 140, startVelocity: 40, origin, shapes: getEmojiShapes(), scalar: 2.4, ticks: 220, flat: true });

    // Side cannons from the bottom corners.
    const cannon = { particleCount: 70, spread: 60, startVelocity: 70, colors: COLORS, ticks: 300 };
    confetti({ ...cannon, angle: 60, origin: { x: 0, y: 1 } });
    confetti({ ...cannon, angle: 120, origin: { x: 1, y: 1 } });
  }

  return { celebrate };
}
