<template>
  <div class="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
    <div class="blob blob-1" />
    <div class="blob blob-2" />
    <div class="blob blob-3" />
    <div class="blob blob-4" />
    <div class="grid-dots absolute inset-0" />
    <div class="grain absolute inset-0" />
  </div>
</template>

<style scoped>
.blob {
  position: absolute;
  width: 55vmax;
  height: 55vmax;
  border-radius: 9999px;
  filter: blur(80px);
  opacity: 0.55;
  will-change: transform;
}
.blob-1 {
  background: var(--blob-1);
  top: -20vmax;
  left: -15vmax;
  animation: drift-1 22s ease-in-out infinite alternate;
}
.blob-2 {
  background: var(--blob-2);
  top: -10vmax;
  right: -20vmax;
  animation: drift-2 26s ease-in-out infinite alternate;
}
.blob-3 {
  background: var(--blob-3);
  bottom: -25vmax;
  left: 10vmax;
  opacity: 0.4;
  animation: drift-3 30s ease-in-out infinite alternate;
}
.blob-4 {
  background: var(--blob-4);
  bottom: -20vmax;
  right: -10vmax;
  animation: drift-1 24s ease-in-out infinite alternate-reverse;
}

@keyframes drift-1 {
  to {
    transform: translate(12vmax, 10vmax) scale(1.15);
  }
}
@keyframes drift-2 {
  to {
    transform: translate(-14vmax, 12vmax) scale(0.9);
  }
}
@keyframes drift-3 {
  to {
    transform: translate(10vmax, -12vmax) scale(1.2);
  }
}

.grid-dots {
  background-image: radial-gradient(color-mix(in oklch, var(--foreground) 18%, transparent) 1px, transparent 1px);
  background-size: 28px 28px;
  mask-image: radial-gradient(ellipse at center, black 20%, transparent 70%);
}

.grain {
  opacity: 0.08;
  mix-blend-mode: overlay;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
}

@media (prefers-reduced-motion: reduce) {
  .blob {
    animation: none;
  }
}
</style>
