FROM python:3.10.13
COPY . .
RUN pip --no-cache-dir install pipenv && \
    apt-get update && apt-get install sqlite3 && \
    apt-get clean autoclean && \
    apt-get autoremove --yes && \
    mkdir /sqlite && \
    sqlite3 /sqlite/torrentio.sqlite "VACUUM;" && \
    cat torrentio.sql | sqlite3 /sqlite/torrentio.sqlite && \
    ls -l /sqlite && \
    pipenv install && touch .init
CMD [ "pipenv", "run", "python", "-u", "scraper.py" ]