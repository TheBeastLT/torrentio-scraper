import os
import re
import math
import requests
import time
from imdb import Cinemagoer
from bs4 import BeautifulSoup
from shared import imdb_find, build_and_write, extract_title, read_config

TORRENT_CACHES = ('http://itorrents.org', 'http://torrage.info', 'http://btcache.me')
BASE_URL = 'https://1337x.to'
MOVIE_BASE = 'https://1337x.to/movie-library'
MOVIE_LIBRARY_MAX_PAGE = 301
CACHE_DIR = "./scrape-cache"
PROVIDER = "1337x"
SLEEP_BETWEEN_REQUESTS = read_config(PROVIDER, "sleep")

if not os.path.exists(CACHE_DIR):
    os.makedirs(CACHE_DIR)

def get_links_and_process(url):
    links = []
    print(f"Requesting movies from: {url}")
    req = requests.get(url, headers={'User-Agent': 'Mozilla/5.0'})
    main = req.text
    soup = BeautifulSoup(main, "html.parser")
    for a in soup.find_all("a"):
        if a.get("href").startswith("/torrent/"):
            links.append((a.get("href"), extract_title(a.text)))
    process_links(links)

def get_links_initial():
    links = []
    for i in range(1,MOVIE_LIBRARY_MAX_PAGE + 1):
        try:
            print(f"Sleeping {SLEEP_BETWEEN_REQUESTS}")
            time.sleep(SLEEP_BETWEEN_REQUESTS)

            main = ""
            if os.path.isfile(f"{CACHE_DIR}/main-{i}.html"):
                print(f"Reading main page({i}) from cache...")
                main = open(f"{CACHE_DIR}/main-{i}.html", "r").read()
            else:
                print(f"Requesting main index: {MOVIE_BASE}/{i}/")
                req = requests.get(f"{MOVIE_BASE}/{i}/", headers={'User-Agent': 'Mozilla/5.0'})
                if req.status_code == 404:
                    print(f"Page does not exist: {MOVIE_BASE}/{i}/. Breaking loop.")
                    break
                main = req.text
                open(f"{CACHE_DIR}/main-{i}.html", "w+").write(main)

            movies = []
            soup = BeautifulSoup(main, "html.parser")
            for h3 in soup.find_all("h3"):
                a = h3.findChildren("a", href=True)[0]
                movie_link = a.get("href")
                movie_title = a.text
                movies.append((movie_title, movie_link))

            for movie in movies:
                if os.path.isfile(f"{CACHE_DIR}{movie[1]}html.html"):
                    print(f"Reading movie page({movie[0]}) from cache...")
                    main = open(f"{CACHE_DIR}{movie[1]}html.html").read()
                else:
                    print(f"Requesting movie releases: {BASE_URL}{movie[1]}")
                    req = requests.get(f"{BASE_URL}{movie[1]}", headers={'User-Agent': 'Mozilla/5.0'})
                    main = req.text
                if not os.path.exists(f"{CACHE_DIR}{movie[1]}"):
                    os.makedirs(f"{CACHE_DIR}{movie[1]}")
                open(f"{CACHE_DIR}{movie[1]}html.html", "w+").write(main)
                soup = BeautifulSoup(main, "html.parser")
                for href in soup.find_all("a"):
                    if href.get("href").startswith("/torrent/"):
                        links.append((href.get("href"), movie[0]))
        except Exception as e:
            print(e)
    return links

def process_links(links):
    print(f"Checking links...({len(links)})")
    counter = 1
    for link in links:
        try:
            print(f"Processing: {BASE_URL}{link[0]} {counter}/{len(links)}")
            req = requests.get(f"{BASE_URL}{link[0]}", headers={'User-Agent': 'Mozilla/5.0'})
            torrent_html = req.text
            t = {}
            soup = BeautifulSoup(torrent_html, "html.parser")
            t['title'] = soup.find("h1").text.strip()
            t['size'] = 0
            t['magnets'] = []
            t['torrents'] = []
            all_a = soup.find_all("a")
            for a in all_a:
                if a.get("href").startswith("https://www.imdb.com/title"):
                    t['imdbid'] = a.get("href").rstrip("\\").split('/')[-1]
                if a.get("href").startswith("magnet:"):
                    t['magnets'].append(a.get("href"))
                if a.get("href").startswith(TORRENT_CACHES):
                    t['torrents'].append(a.get("href"))
            all_li = soup.find_all("li")
            for li in all_li:
                if "Total size" in li.text:
                    size = li.findChildren("span")[0].text
                    mb = False
                    if "MB" in size: mb = True
                    size = re.sub('\s(GB|MB)', '', size).split('.')[0].replace(',','')
                    if mb:
                        t['size'] = math.trunc(float(size) * 107374182)
                    else:
                        t['size'] = math.trunc(float(size) * 1073741824)
            t['seeders'] = soup.find("span", {"class": "seeds"}).text
            all_p = soup.find_all("p")
            for p in all_p:
                if "Infohash :" in p.text:
                    t['infoHash'] = p.findChildren("span")[0].text.lower()
            t['files'] = []
            file_div = soup.find("div", {"id":"files"})
            for li in file_div.findChildren("li"):
                f = re.sub('\s\(.*\)', '', li.text)
                t["files"].append(f)
            t['trackers'] = []
            tracker_div = soup.find("div", {"id":"tracker-list"})
            for tracker in tracker_div.findChildren("li"):
                t['trackers'].append(tracker.text.strip())
            if not 'imdbid' in t or t['imdbid'] == '':
                found = re.search("https:\/\/www\.imdb\.com\/title\/tt\d+", torrent_html)
                if found is not None:
                    t['imdbid'] = found.group(0).rstrip("\\").split('/')[-1]
                else:
                    new_id = imdb_find(link[1])
                    if new_id is not None:
                        t['imdbid'] = f"tt{new_id}"
                    else:
                        print(f"{t['title']} has no IMDB Id")
                        continue
            build_and_write(t)
        except:
            counter += 1
            continue
        counter += 1