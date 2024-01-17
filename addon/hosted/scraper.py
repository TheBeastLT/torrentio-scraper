import os
import threading
from p1337x import process_links, get_links_initial, get_links_and_process
from apscheduler.schedulers.background import BackgroundScheduler
from shared import read_config

print("Scaper starting...")

if os.path.isfile(".init"):
    print("Found init file, executing initial sync. Be patient.")
    process_links(get_links_initial())
    os.remove(".init")

sched = BackgroundScheduler(timezone="America/New_York")
sched.start()

# 1337x
PROVIDER = "1337x"
pages = read_config(PROVIDER, "urls_to_scrape")
interval = read_config(PROVIDER, "scrape_interval")
for page in pages:
    j = sched.add_job(
        get_links_and_process, 
        'interval', 
        days=interval["days"],
        hours=interval["hours"],
        minutes=interval["minutes"],
        seconds=interval["seconds"],
        id=page,
        args=[page],
        max_instances=1)
    print(f"{page} willl be scraped {j.next_run_time}.")


# Wait forever
main_thread = threading.main_thread()
while True:
    L = threading.enumerate()
    L.remove(main_thread)  # or avoid it in the for loop
    for t in L:
        t.join()