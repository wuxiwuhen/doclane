export default function handler(req, res) {
  res.json({ url: req.url, path: req.query.path || null });
}
