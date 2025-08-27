const express = require("express");
const supabase = require("../config/supabase");
const apicache = require("apicache");

const router = express.Router();
const cache = apicache.middleware;


// GET all stickers
router.get("/all", cache("1 minute"), async (req, res) => {
  const { data, error } = await supabase.from("stickers").select("*");
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET sticker by ID
router.get("/:id", cache("1 minute"), async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase.from("stickers").select("*").eq("id", id).single();
  if (error) return res.status(404).json({ error: "Sticker not found" });
  res.json(data);
});

// POST create sticker
router.post("/", async (req, res) => {
  const { name, image_url } = req.body;
  const { data, error } = await supabase
    .from("stickers")
    .insert([{ name, image_url }])
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// PUT update sticker
router.put("/:id", async (req, res) => {
  const { id } = req.params;
  const { name, image_url } = req.body;

  const { data, error } = await supabase
    .from("stickers")
    .update({ name, image_url })
    .eq("id", id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE sticker
router.delete("/:id", async (req, res) => {
  const { id } = req.params;

  const { data, error } = await supabase
    .from("stickers")
    .delete()
    .eq("id", id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: "Sticker deleted", data });
});

module.exports = router;
