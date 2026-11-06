import { createRouter, createWebHashHistory } from "vue-router";
import HomeView from "@/views/HomeView.vue";

// Hash history keeps deep links working when Wails serves the embedded files.
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [{ path: "/", name: "home", component: HomeView }],
});
