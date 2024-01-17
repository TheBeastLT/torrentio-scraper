import sqlite3
import re
import os
import json
from imdb import Cinemagoer

SQLITE_PATH = "/sqlite/torrentio.sqlite"

ia = Cinemagoer()
CONFIG = "config.json"

def read_config(provider, key):
    if os.path.isfile(CONFIG):
        f = open(CONFIG, "r")
        cfg = json.load(f)
        return cfg[provider][key]

def filter_file(file):
    allowed_ext = ['.mp4', '.mkv', '.avi', '.mpeg', '.mpg', '.mpv', '.mov']
    if os.path.splitext(file)[1] in allowed_ext:
        return True
    return False

def create_connection(db_file):
    conn = None
    try:
        conn = sqlite3.connect(db_file, check_same_thread=False)
    except Exception as e:
        print(e)
        exit(1)
    return conn

sqlite = create_connection(SQLITE_PATH)

def build_and_write(torrent):
    try:
        print(f"Recording {torrent['title']} in the database")  
        q = f"INSERT OR REPLACE INTO torrents (infoHash, provider, title, size, type, uploadDate, seeders, trackers) VALUES (?,?,?,?,?,?,?,?)"
        p = (torrent['infoHash'],'1337x',torrent['title'],torrent['size'],'movie','1/1/2024',torrent['seeders'],','.join(torrent['trackers']))
        cursor = sqlite.cursor()
        cursor.execute(q,p)
        for file in torrent['files']:
            if filter_file(file):
                q = f"INSERT OR REPLACE INTO files (infoHash, fileIndex, title, size, imdbId) VALUES (?,?,?,?,?)"
                p = (torrent['infoHash'], torrent['files'].index(file), file, torrent['size'], torrent['imdbid'])
                cursor.execute(q,p)
        sqlite.commit()
        cursor.close()
    except sqlite3.Error as error:
        print(error)

def imdb_find(name):
    movie = ia.search_movie(name)
    if len(movie) >= 1:
        return movie[0].movieID
    return None

def extract_title(filename):
    try:
        filename.strip()
        filename = filename.replace('.', ' ')
        res = re.search('([^\\\]+)\.(avi|mkv|mpeg|mpg|mov|mp4)$', filename)
        if res:
            filename = res.group(1)
        res = re.search('(.*?)(dvdrip|xvid| cd[0-9]|dvdscr|brrip|divx|[\{\(\[]?[0-9]{4}).*', filename)
        if res:
            filename = res.group(1)
        res = re.search('(.*?)\(.*\)(.*)', filename)
        if res:
            filename = res.group(1)
        return filename
    except:
        return ""
