export default function handler(req, res) {
  res.json({ url: req.url, test: true });
}
