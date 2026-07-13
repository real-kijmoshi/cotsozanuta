const express = require("express");
const { VIEWS_DIR } = require("../config");

const router = express.Router();

// Static HTML page routes. Each just serves a view from public/views.
// Using the `root` option (rather than an absolute path) keeps send's dotfile
// protection scoped to the filename, so serving works even if the project lives
// under a dot-prefixed directory.
const page = (file) => (req, res) => res.sendFile(file, { root: VIEWS_DIR });

router.get("/", page("index.html"));
router.get("/admin", page("admin.html"));
router.get("/admin/stats", page("admin-stats.html"));
router.get("/regulamin", page("regulamin.html"));
router.get("/polityka-prywatnosci", page("polityka-prywatnosci.html"));
router.get("/discografia", page("discografia.html"));
router.get("/ranking", page("ranking.html"));

module.exports = router;
