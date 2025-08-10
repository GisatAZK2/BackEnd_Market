const express = require("express");
const router = express.Router();
const fetch = require("node-fetch");

// === Utility fetch JSON ===
async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch gagal: ${res.status}`);
  return res.json();
}

// === Utility untuk fetch data wilayah ===
async function getProvinces() {
  return fetchJSON(
    "https://www.emsifa.com/api-wilayah-indonesia/api/provinces.json",
  );
}

async function getRegencies(provinsiId) {
  return fetchJSON(
    `https://www.emsifa.com/api-wilayah-indonesia/api/regencies/${provinsiId}.json`,
  );
}

async function getDistricts(kabupatenId) {
  return fetchJSON(
    `https://www.emsifa.com/api-wilayah-indonesia/api/districts/${kabupatenId}.json`,
  );
}

async function getVillages(kecamatanId) {
  return fetchJSON(
    `https://www.emsifa.com/api-wilayah-indonesia/api/villages/${kecamatanId}.json`,
  );
}

// === Endpoint wilayah ===
router.get("/wilayah/provinsi", async (req, res) => {
  try {
    const provinces = await getProvinces();
    res.json(provinces);
  } catch (err) {
    res
      .status(500)
      .json({ message: "❌ Gagal ambil data provinsi", error: err.message });
  }
});

router.get("/wilayah/kabupaten/:provinsiId", async (req, res) => {
  try {
    const regencies = await getRegencies(req.params.provinsiId);
    res.json(regencies);
  } catch (err) {
    res
      .status(500)
      .json({ message: "❌ Gagal ambil data kabupaten", error: err.message });
  }
});

router.get("/wilayah/kecamatan/:kabupatenId", async (req, res) => {
  try {
    const districts = await getDistricts(req.params.kabupatenId);
    res.json(districts);
  } catch (err) {
    res
      .status(500)
      .json({ message: "❌ Gagal ambil data kecamatan", error: err.message });
  }
});

router.get("/wilayah/kelurahan/:kecamatanId", async (req, res) => {
  try {
    const villages = await getVillages(req.params.kecamatanId);
    res.json(villages);
  } catch (err) {
    res
      .status(500)
      .json({ message: "❌ Gagal ambil data kelurahan", error: err.message });
  }
});

module.exports = {
  router, // router dengan endpoint wilayah
  getProvinces,
  getRegencies,
  getDistricts,
  getVillages,
  fetchJSON,
};
