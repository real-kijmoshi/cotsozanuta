const express = require("express");
const genius = require("./utils/genius");

const app = express();
const PORT = process.env.PORT || 3000;

let otsochodziId = null;
genius.getArtistIdByName("otsochodzi").then((artistId) => {
  otsochodziId = artistId;
  console.log(`Artist ID for Otsochodzi: ${artistId}`);
  genius.getAllSongs(artistId).then((songs) => {
    console.log(`Songs for Otsochodzi: ${songs.length}`);
    songs.forEach((song) => {
        console.log(`- ${song.title}`);
    });
  });
});

app.use(express.json())
app.use(express.static("public"))
app.set("view engine", "ejs");

app.get("/", (req, res) => {
    res.render("index");
})


app.get("/api/game/endless", async (req, res) => {
    try {
        const song = await genius.getSongListForArtist(otsochodziId).then(songs => songs[Math.floor(Math.random() * songs.length)]);
        const moreSongInfo = await genius.getSongById(song.id);
        res.json({ songId: song.id, hints: { album: moreSongInfo.album?.name, releaseDate: moreSongInfo.releaseDate } });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to fetch song" });
    }
});

app.get("/api/lyrics", async (req, res) => {
    const { songId, wordIndex } = req.query;
    if (!songId || !wordIndex) {
        return res.status(400).json({ error: "Missing songId or wordIndex" });
    }

    try {
        const lyrics = (await genius.getSongById(songId)).lyrics;
        const words = lyrics.split(/\s+/);
        if (wordIndex < 0 || wordIndex >= words.length) {
            return res.status(400).json({ error: "Invalid wordIndex" });
        }
        res.json({ word: words[wordIndex] });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to fetch lyrics" });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});