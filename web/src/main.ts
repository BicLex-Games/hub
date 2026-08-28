const params = new URLSearchParams(window.location.search);

if (params.has("serverSettings")) {
  void import("./server-settings");
} else {
  void import("./app");
}
