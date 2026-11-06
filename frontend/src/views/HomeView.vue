<script setup lang="ts">
import { ref, useTemplateRef } from "vue";
import { storeToRefs } from "pinia";
import { onKeyStroke, unrefElement, useDark, useTimeoutFn, useToggle } from "@vueuse/core";
import { useMutation } from "@tanstack/vue-query";
import { AnimatePresence, motion } from "motion-v";
import { PartyService } from "../../bindings/tada";
import { Moon, PartyPopper, RotateCcw, Sun } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import AuroraBackground from "@/components/AuroraBackground.vue";
import CelebrationSettings from "@/components/CelebrationSettings.vue";
import { useConfetti } from "@/composables/useConfetti";
import { usePartyStore } from "@/stores/party";

const party = usePartyStore();
const { pops, message } = storeToRefs(party);

const isDark = useDark();
const toggleDark = useToggle(isDark);

const { celebrate } = useConfetti();
const partyButton = useTemplateRef("partyButton");

// The headline stays up for a moment after the last pop, then fades out.
const showTada = ref(false);
const { start: scheduleHide } = useTimeoutFn(() => (showTada.value = false), 1600, { immediate: false });

// Outside the Wails window (plain browser on the Vite server) there is no Go backend to answer.
const cheer = useMutation({
  mutationFn: (count: number) =>
    PartyService.Celebrate(count).catch(() => `Pop #${count} (browser preview)`),
});

function tada(el: HTMLElement) {
  el.animate(
    [
      { transform: "scale(1) rotate(0)" },
      { transform: "scale(0.9) rotate(-3deg)", offset: 0.1 },
      { transform: "scale(0.9) rotate(-3deg)", offset: 0.2 },
      { transform: "scale(1.1) rotate(3deg)", offset: 0.3 },
      { transform: "scale(1.1) rotate(-3deg)", offset: 0.4 },
      { transform: "scale(1.1) rotate(3deg)", offset: 0.5 },
      { transform: "scale(1.1) rotate(-3deg)", offset: 0.6 },
      { transform: "scale(1.1) rotate(3deg)", offset: 0.7 },
      { transform: "scale(1.1) rotate(-3deg)", offset: 0.8 },
      { transform: "scale(1.1) rotate(3deg)", offset: 0.9 },
      { transform: "scale(1) rotate(0)" },
    ],
    { duration: 800, easing: "ease-out" },
  );
}

function pop() {
  const count = party.pop();
  const el = unrefElement(partyButton) as HTMLElement | undefined;
  if (el) {
    tada(el);
    const rect = el.getBoundingClientRect();
    celebrate({
      x: (rect.left + rect.width / 2) / window.innerWidth,
      y: (rect.top + rect.height / 2) / window.innerHeight,
    });
  }
  showTada.value = true;
  scheduleHide();
  cheer.mutate(count);
}

// Space/Enter anywhere pops, except where those keys already mean something.
onKeyStroke([" ", "Enter"], (e) => {
  if (e.repeat || (e.target as HTMLElement).closest("input, textarea, button, [contenteditable]")) return;
  e.preventDefault();
  pop();
});
</script>

<template>
  <div class="relative h-full w-full">
    <AuroraBackground />

    <header class="absolute inset-x-0 top-0 z-10 flex items-center justify-between px-6 py-4">
      <div class="flex items-center gap-2.5 font-semibold tracking-tight">
        <span class="grid size-8 place-items-center rounded-lg bg-primary/15 text-primary">
          <PartyPopper class="size-4" />
        </span>
        Tada
      </div>
      <div class="flex items-center gap-1.5">
        <span class="mr-1.5 rounded-full border bg-card/60 px-3 py-1 text-sm tabular-nums backdrop-blur-xl">
          {{ pops }} {{ pops === 1 ? "pop" : "pops" }}
        </span>
        <Button variant="ghost" size="icon" :disabled="!pops" aria-label="Reset counter" @click="party.reset()">
          <RotateCcw />
        </Button>
        <Button variant="ghost" size="icon" :aria-label="isDark ? 'Light mode' : 'Dark mode'" @click="toggleDark()">
          <Sun v-if="isDark" />
          <Moon v-else />
        </Button>
      </div>
    </header>

    <main class="relative grid h-full place-items-center">
      <div class="flex flex-col items-center">
        <div class="relative mb-10 grid h-28 w-[36rem] max-w-[90vw] place-items-center">
          <AnimatePresence>
            <motion.div
              v-if="showTada"
              :key="pops"
              class="absolute flex flex-col items-center"
              :initial="{ opacity: 0, scale: 0.3, y: 30, rotate: -8 }"
              :animate="{ opacity: 1, scale: 1, y: 0, rotate: 0, transition: { type: 'spring', stiffness: 420, damping: 14 } }"
              :exit="{ opacity: 0, scale: 1.3, y: -30, transition: { duration: 0.35 } }"
            >
              <span class="tada-text font-display text-7xl font-black tracking-tight">{{ message }}</span>
              <span v-if="cheer.data.value" class="mt-1 text-sm font-medium text-muted-foreground">
                {{ cheer.data.value }}
              </span>
            </motion.div>
          </AnimatePresence>
        </div>

        <div class="relative">
          <div class="glow-ring absolute -inset-6 rounded-full" aria-hidden="true" />
          <Button ref="partyButton" class="party-button" aria-label="Celebrate" @click="pop">
            <PartyPopper class="size-20! drop-shadow-md" :stroke-width="1.75" />
            <span class="text-xl font-bold tracking-wide drop-shadow">Pop!</span>
          </Button>
        </div>

        <p class="mt-14 text-sm text-muted-foreground">
          Click, or press
          <kbd class="rounded-md border bg-card/60 px-1.5 py-0.5 font-sans text-xs shadow-xs">Space</kbd>
        </p>
      </div>
    </main>

    <CelebrationSettings class="absolute bottom-6 left-6 z-10" />
  </div>
</template>

<style scoped>
.party-button {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  width: 15rem;
  height: 15rem;
  border-radius: 9999px;
  color: white;
  background:
    radial-gradient(circle at 30% 22%, rgb(255 255 255 / 0.55), transparent 42%),
    conic-gradient(from 210deg, #ff4fa3, #ffb547, #7c5cff, #2ee6c5, #ff4fa3);
  box-shadow:
    0 30px 80px -20px rgb(255 79 163 / 0.65),
    0 10px 30px -10px rgb(124 92 255 / 0.5),
    inset 0 -10px 30px rgb(0 0 0 / 0.18),
    inset 0 6px 16px rgb(255 255 255 / 0.45);
  transition:
    scale 150ms ease,
    box-shadow 200ms ease;
  cursor: pointer;
}
.party-button:hover {
  scale: 1.04;
  background:
    radial-gradient(circle at 30% 22%, rgb(255 255 255 / 0.6), transparent 42%),
    conic-gradient(from 210deg, #ff4fa3, #ffb547, #7c5cff, #2ee6c5, #ff4fa3);
}
.party-button:active {
  scale: 0.96;
}

.glow-ring {
  background: conic-gradient(from 0deg, #ff4fa3, #ffb547, #7c5cff, #2ee6c5, #ff4fa3);
  filter: blur(36px);
  opacity: 0.55;
  animation: spin 8s linear infinite;
}

.tada-text {
  background: linear-gradient(100deg, #ff4fa3, #ffb547 40%, #7c5cff 75%, #2ee6c5);
  background-clip: text;
  color: transparent;
  filter: drop-shadow(0 6px 18px rgb(124 92 255 / 0.35));
  white-space: nowrap;
}

@keyframes spin {
  to {
    rotate: 360deg;
  }
}
</style>
