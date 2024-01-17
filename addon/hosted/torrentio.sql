CREATE TABLE "torrents" (
	"infoHash"	TEXT,
	"provider"	TEXT NOT NULL,
	"torrentId"	TEXT,
	"title"	TEXT NOT NULL,
	"size"	INTEGER,
	"type"	TEXT NOT NULL,
	"uploadDate"	TEXT NOT NULL,
	"seeders"	INTEGER,
	"trackers"	TEXT,
	"languages"	TEXT,
	"resolution"	TEXT,
	"createdAt" TEXT,
	"updatedAt" TEXT,
	PRIMARY KEY("infoHash")
);

CREATE TABLE "files" (
	"id" INTEGER,
	"infoHash" TEXT NOT NULL,
	"fileIndex"	TEXT,
	"title" INTEGER,
	"size" INTEGER,
	"imdbId" TEXT,
	"imdbSeason" INTEGER,
	"imdbEpisode" INTEGER,
    "kitsuId" INTEGER,
    "kitsuEpisode" INTEGER,
	"createdAt" TEXT,
	"updatedAt" TEXT,
    FOREIGN KEY("infoHash") REFERENCES "torrent"("infoHash") ON DELETE CASCADE,
	PRIMARY KEY("id" AUTOINCREMENT)
	UNIQUE(infoHash, fileIndex)
);

CREATE TABLE "subtitles" (
	"infoHash" TEXT NOT NULL,
    "fileIndex" INTEGER NOT NULL,
    "fileId" INTEGER,
    "title" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    FOREIGN KEY("fileId") REFERENCES "file"("id") ON DELETE SET NULL
    FOREIGN KEY("infoHash") REFERENCES "torrent"("infoHash") ON DELETE CASCADE
);