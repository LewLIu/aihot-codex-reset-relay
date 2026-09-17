export default {
  async fetch() {
    return Response.json({ service: "aihot-codex-reset-relay" });
  },
  async scheduled(_controller, _env, _ctx) {},
};
