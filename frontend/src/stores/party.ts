import { defineStore } from "pinia";
import { useStorage } from "@vueuse/core";

export const usePartyStore = defineStore("party", () => {
  const pops = useStorage("tada:pops", 0);
  const message = useStorage("tada:message", "Tada!");

  function pop() {
    pops.value++;
    return pops.value;
  }

  function reset() {
    pops.value = 0;
  }

  return { pops, message, pop, reset };
});
