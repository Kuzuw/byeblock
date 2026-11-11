// Vercel entry point: every request is rewritten here (see vercel.json) and
// handled by the same code as the standalone server. req.url keeps the
// original path, e.g. /api-v2/tracks?ids=1.
let handler;

module.exports = async (req, res) => {
  if (!handler) {
    const { createHandler } = await import('../server/server.mjs');
    handler = createHandler();
  }
  return handler(req, res);
};
