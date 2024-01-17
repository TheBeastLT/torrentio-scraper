CREATE TABLE "torrents" (
	"infoHash" 	varchar(64) PRIMARY KEY,
	"provider"	varchar(32) NOT NULL,
	"torrentId"	varchar(128),
	"title"	varchar(256) NOT NULL,
	"size"	bigint,
	"type"	varchar(16) NOT NULL,
	"uploadDate"	date NOT NULL,
	"seeders"	integer,
	"trackers"	varchar(4096),
	"languages"	varchar(4096),
	"resolution"	varchar(16),
	"createdAt"	date,
	"updatedAt"	date,
	"reviewed"	boolean,
	"opened"	boolean
);

CREATE TABLE "files" (
	"id"	SERIAL PRIMARY KEY,
	"infoHash"	varchar(64) NOT NULL,
	"fileIndex"	integer,
	"title"	varchar(256) NOT NULL,
	"size"	bigint,
	"imdbId"	varchar(32),
	"imdbSeason"	integer,
	"imdbEpisode"	integer,
	"kitsuId"	integer,
	"kitsuEpisode"	integer,
	"createdAt"	date,
	"updatedAt"	date,
	FOREIGN KEY("infoHash") REFERENCES torrents("infoHash") ON DELETE CASCADE,
	UNIQUE("infoHash","fileIndex")
);

CREATE TABLE "subtitles" (
	"id"	SERIAL PRIMARY KEY,
	"infoHash"	varchar(64) NOT NULL,
	"fileIndex"	integer NOT NULL,
	"fileId"	bigint,
	"title"	varchar(512) NOT NULL,
	"size"	bigint,
	FOREIGN KEY("infoHash") REFERENCES torrents("infoHash") ON DELETE CASCADE,
	FOREIGN KEY("fileId") REFERENCES files("id") ON DELETE SET NULL
);

CREATE TABLE "contents" (
	"infoHash"	varchar(64),
	"fileIndex"	integer,
	"path"	varchar(256),
	"size"	bigint,
	FOREIGN KEY("infoHash") REFERENCES torrents("infoHash") ON DELETE CASCADE
);