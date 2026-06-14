"""Amazon session acquisition for the Kindle companion (cookie-only).

NO password is ever stored or transmitted. First run opens a real browser
for Clay to log into Amazon himself; the companion then captures the session
COOKIES (via Chrome DevTools Protocol, all domains) and DPAPI-encrypts them to
%APPDATA%\\AquiloKindle\\session.enc. Subsequent runs restore those cookies
into a headless browser, so no further login is needed until they expire.

Everything runs on Clay's machine. Cookies never touch any server.
"""
import time

import config
from logsetup import log

NOTEBOOK_URL = "https://read.amazon.com/notebook"
HOME_URL = "https://read.amazon.com/"
# Cookie names that only exist once an Amazon sign-in has completed. Their
# presence is how we detect "the user finished logging in" during first run.
AUTH_COOKIE_NAMES = {"at-main", "sess-at-main", "x-main"}


def _chrome_options(headless):
    from selenium.webdriver.chrome.options import Options
    o = Options()
    if headless:
        o.add_argument("--headless=new")
    o.add_argument("--window-size=1280,1000")
    o.add_argument("--no-first-run")
    o.add_argument("--no-default-browser-check")
    o.add_argument("--disable-blink-features=AutomationControlled")
    o.add_experimental_option("excludeSwitches", ["enable-automation"])
    return o


def _edge_options(headless):
    from selenium.webdriver.edge.options import Options
    o = Options()
    if headless:
        o.add_argument("--headless=new")
    o.add_argument("--window-size=1280,1000")
    o.add_argument("--no-first-run")
    o.add_argument("--no-default-browser-check")
    return o


def make_driver(headless=True):
    """Build a Selenium driver. Tries Chrome, then Edge. Selenium Manager
    resolves the matching driver binary automatically (downloads to cache on
    first use, needs network that one time)."""
    from selenium import webdriver
    try:
        d = webdriver.Chrome(options=_chrome_options(headless))
        log("driver: chrome")
        return d
    except Exception as e:
        log(f"chrome unavailable ({str(e)[:80]}); trying edge", "warning")
    try:
        d = webdriver.Edge(options=_edge_options(headless))
        log("driver: edge")
        return d
    except Exception as e:
        log(f"edge unavailable ({str(e)[:80]})", "error")
        raise RuntimeError("No supported browser (Chrome or Edge) could be launched.")


def _all_cookies(driver):
    try:
        return driver.execute_cdp_cmd("Network.getAllCookies", {}).get("cookies", [])
    except Exception:
        # Fallback: current-domain cookies only.
        try:
            return driver.get_cookies()
        except Exception:
            return []


def _restore_cookies(driver, cookies):
    for c in cookies:
        ck = {
            "name": c.get("name"),
            "value": c.get("value"),
            "domain": c.get("domain"),
            "path": c.get("path", "/"),
            "secure": bool(c.get("secure", False)),
            "httpOnly": bool(c.get("httpOnly", False)),
        }
        if c.get("expires") and c["expires"] > 0:
            ck["expires"] = c["expires"]
        try:
            driver.execute_cdp_cmd("Network.setCookie", ck)
        except Exception:
            pass


def _looks_signed_in(cookies):
    names = {c.get("name") for c in cookies}
    return bool(AUTH_COOKIE_NAMES & names)


def login_interactive(timeout=300, on_open=None):
    """Open a visible browser, let Clay sign in, capture cookies. Blocking;
    returns True on success. Runs on its own thread from the controller."""
    log("interactive login: opening browser")
    driver = None
    try:
        driver = make_driver(headless=False)
        driver.get(NOTEBOOK_URL)
        if callable(on_open):
            try:
                on_open()
            except Exception:
                pass
        deadline = time.time() + timeout
        while time.time() < deadline:
            cookies = _all_cookies(driver)
            if _looks_signed_in(cookies):
                # Give the page a beat to settle any final auth cookies.
                time.sleep(2)
                cookies = _all_cookies(driver)
                config.save_cookies(cookies)
                log(f"interactive login: captured {len(cookies)} cookies")
                return True
            time.sleep(2)
        log("interactive login: timed out waiting for sign-in", "warning")
        return False
    except Exception as e:
        log(f"interactive login failed: {str(e)[:120]}", "error")
        return False
    finally:
        if driver is not None:
            try:
                driver.quit()
            except Exception:
                pass


def build_authenticated_driver():
    """Headless driver with the cached cookies restored, parked on the
    notebook page. Returns the driver, or None if there is no cached session
    or the session has expired (caller should then prompt interactive login)."""
    cookies = config.load_cookies()
    if not cookies:
        return None
    driver = make_driver(headless=True)
    try:
        # Land on the domain first so setCookie targets the right store.
        driver.get(HOME_URL)
        _restore_cookies(driver, cookies)
        driver.get(NOTEBOOK_URL)
        time.sleep(2)
        url = (driver.current_url or "").lower()
        if "signin" in url or "/ap/" in url:
            log("cached session expired (redirected to sign-in)", "warning")
            try:
                driver.quit()
            except Exception:
                pass
            return None
        return driver
    except Exception as e:
        log(f"authenticated driver failed: {str(e)[:120]}", "error")
        try:
            driver.quit()
        except Exception:
            pass
        return None
