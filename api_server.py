#!/usr/bin/env python3
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import cloudscraper
from bs4 import BeautifulSoup
import re
import time
import io
from typing import Optional
import uvicorn
import sys

app = FastAPI(title="AppOmar APK Download API", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def create_scraper():
    return cloudscraper.create_scraper(
        browser={
            'browser': 'chrome',
            'platform': 'windows',
            'desktop': True
        }
    )

@app.get("/")
async def root():
    return {
        "service": "AppOmar APK Download API",
        "version": "2.0.0",
        "status": "running",
        "endpoints": {
            "/download/{package_name}": "Download APK file",
            "/info/{package_name}": "Get APK information",
            "/apps": "List of 10 recommended apps with bot image"
        }
    }

@app.get("/health")
async def health_check():
    return {"status": "healthy", "service": "apk-download-api"}

@app.get("/info/{package_name}")
async def get_apk_info(package_name: str):
    """Get APK information without downloading"""
    scraper = create_scraper()

    try:
        app_url = f"https://apkpure.com/{package_name}/{package_name}"
        response = scraper.get(app_url, timeout=15)

        if response.status_code != 200:
            raise HTTPException(status_code=404, detail="Application not found")

        soup = BeautifulSoup(response.content, 'lxml')

        title = soup.find('h1', class_='title')
        version = soup.find('span', class_='version')
        size = soup.find('span', class_='fsize')

        return {
            "package_name": package_name,
            "title": title.text.strip() if title else package_name,
            "version": version.text.strip() if version else "Unknown",
            "size": size.text.strip() if size else "Unknown",
            "url": app_url
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error: {str(e)}")

@app.get("/download/{package_name}")
async def download_apk(package_name: str, stream: bool = True):
    """Download APK file"""
    scraper = create_scraper()

    try:
        app_url = f"https://apkpure.com/{package_name}/{package_name}"
        response = scraper.get(app_url, timeout=15)

        if response.status_code != 200:
            raise HTTPException(status_code=404, detail="Application not found")

        soup = BeautifulSoup(response.content, 'lxml')
        download_link = None

        download_btn = soup.find('a', class_=re.compile(r'download.*btn|btn.*download', re.I))
        if not download_btn:
            download_btn = soup.find('a', href=re.compile(r'/download'))

        if download_btn and download_btn.get('href'):
            download_url = str(download_btn.get('href', ''))

            if download_url.startswith('/'):
                download_url = 'https://apkpure.com' + download_url

            print(f"رابط التحميل: {download_url}", file=sys.stderr)

            dl_response = scraper.get(download_url, timeout=15)
            dl_soup = BeautifulSoup(dl_response.content, 'lxml')

            direct_link = dl_soup.find('a', {'id': 'download_link'})
            if direct_link and direct_link.get('href'):
                download_link = str(direct_link.get('href', ''))
            else:
                iframe = dl_soup.find('iframe', {'id': 'iframe_download'})
                if iframe and iframe.get('src'):
                    download_link = str(iframe.get('src', ''))
                else:
                    meta_refresh = dl_soup.find('meta', {'http-equiv': 'refresh'})
                    if meta_refresh:
                        content = str(meta_refresh.get('content', ''))
                        match = re.search(r'url=(.+)', content)
                        if match:
                            download_link = match.group(1)

        if not download_link:
            alternate_url = f"https://d.apkpure.com/b/APK/{package_name}?version=latest"
            download_link = alternate_url

        if download_link:
            file_response = scraper.get(download_link, timeout=120, stream=True)

            if file_response.status_code == 200:
                content_type = file_response.headers.get('Content-Type', '')

                if 'html' in content_type.lower():
                    raise HTTPException(status_code=400, detail="Invalid download link")

                file_name = f"{package_name}.apk"

                content_disposition = file_response.headers.get('content-disposition', '')
                if content_disposition:
                    filename_match = re.search(r'filename[^;=\n]*=(([\'"]).*?\2|[^;\n]*)', content_disposition)
                    if filename_match:
                        file_name = filename_match.group(1).strip('\'"')

                if '.xapk' in download_link.lower() or 'xapk' in content_type.lower():
                    file_name = file_name.replace('.apk', '.xapk')
                elif '.apks' in download_link.lower():
                    file_name = file_name.replace('.apk', '.apks')

                if stream:
                    def generate():
                        for chunk in file_response.iter_content(chunk_size=8192):
                            if chunk:
                                yield chunk

                    return StreamingResponse(
                        generate(),
                        media_type="application/vnd.android.package-archive",
                        headers={
                            "Content-Disposition": f"attachment; filename={file_name}",
                            "Content-Length": file_response.headers.get('Content-Length', '0')
                        }
                    )
                else:
                    content = b''.join([chunk for chunk in file_response.iter_content(chunk_size=8192) if chunk])
                    return StreamingResponse(
                        io.BytesIO(content),
                        media_type="application/vnd.android.package-archive",
                        headers={
                            "Content-Disposition": f"attachment; filename={file_name}",
                            "Content-Length": str(len(content))
                        }
                    )
            else:
                raise HTTPException(status_code=500, detail="Download failed")
        else:
            raise HTTPException(status_code=404, detail="Download link not found")

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error: {str(e)}")

@app.get("/apps")
async def get_recommended_apps():
    """Get a list of 10 recommended apps with bot image"""
    scraper = create_scraper()
    apps_data = []
    bot_image_url = "https://example.com/bot_image.png" # Placeholder for bot image URL

    try:
        # Fetching a page with a list of apps (e.g., top charts or popular apps)
        # This is a placeholder and might need adjustment based on actual website structure
        response = scraper.get("https://apkpure.com/store/apps", timeout=15)
        if response.status_code != 200:
            raise HTTPException(status_code=500, detail="Failed to fetch app list page")

        soup = BeautifulSoup(response.content, 'lxml')

        # Find app containers
        app_containers = soup.find_all('div', class_='category-item') # Adjust class as needed

        count = 0
        for container in app_containers:
            if count >= 10:
                break

            title_tag = container.find('p', class_='title')
            package_name_tag = container.find('a', href=re.compile(r'/[^/]+/[^/]+$'))
            img_tag = container.find('img')

            if title_tag and package_name_tag and img_tag:
                title = title_tag.text.strip()
                package_name = package_name_tag['href'].split('/')[-1]
                app_icon_url = img_tag.get('src', '')

                apps_data.append({
                    "title": title,
                    "package_name": package_name,
                    "icon_url": app_icon_url if app_icon_url else bot_image_url, # Use bot image if app icon is missing
                    "bot_image_used": not app_icon_url
                })
                count += 1

        if not apps_data:
            # Fallback if no apps found from the primary source
            # This could be a hardcoded list or another scraping target
            fallback_apps = [
                {"title": "App 1", "package_name": "com.example.app1", "icon_url": bot_image_url, "bot_image_used": True},
                {"title": "App 2", "package_name": "com.example.app2", "icon_url": bot_image_url, "bot_image_used": True},
                {"title": "App 3", "package_name": "com.example.app3", "icon_url": bot_image_url, "bot_image_used": True},
                {"title": "App 4", "package_name": "com.example.app4", "icon_url": bot_image_url, "bot_image_used": True},
                {"title": "App 5", "package_name": "com.example.app5", "icon_url": bot_image_url, "bot_image_used": True},
                {"title": "App 6", "package_name": "com.example.app6", "icon_url": bot_image_url, "bot_image_used": True},
                {"title": "App 7", "package_name": "com.example.app7", "icon_url": bot_image_url, "bot_image_used": True},
                {"title": "App 8", "package_name": "com.example.app8", "icon_url": bot_image_url, "bot_image_used": True},
                {"title": "App 9", "package_name": "com.example.app9", "icon_url": bot_image_url, "bot_image_used": True},
                {"title": "App 10", "package_name": "com.example.app10", "icon_url": bot_image_url, "bot_image_used": True},
            ]
            return fallback_apps

        return apps_data

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error fetching recommended apps: {str(e)}")


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")