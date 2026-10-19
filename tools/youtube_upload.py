"""YouTube upload for DEEPSEA (YouTube Data API v3; same OAuth token as the vtuber/malfoy projects, kept outside this folder).
  /home/daforce/.venvs/malfoy-yt/bin/python tools/youtube_upload.py check
  /home/daforce/.venvs/malfoy-yt/bin/python tools/youtube_upload.py upload <key> [--privacy private|unlisted|public] [--thumb thumb.jpg]
<key> is an entry in tools/youtube.json: {"<key>": {"file", "title", "description", "tags", "short"}}.
Log: renders/youtube_uploads.json (a key already logged is never uploaded twice). Quota is shared with the other projects.
Declares altered/synthetic content (containsSyntheticMedia), not made for kids.
"""
import json, sys, datetime
from pathlib import Path
R = Path(__file__).resolve().parent.parent
TOKEN = Path('/home/daforce/.config/vtuber_youtube/youtube_token.json')
LOG = R / 'renders/youtube_uploads.json'
SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube']
def arg(k, d=None): return sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d

def yt():
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request
    from googleapiclient.discovery import build
    c = Credentials.from_authorized_user_file(str(TOKEN), SCOPES)
    if c.expired and c.refresh_token: c.refresh(Request()); TOKEN.write_text(c.to_json())
    if not c.valid: raise RuntimeError('token invalid: re-run auth in the malfoy project and re-copy the token')
    return build('youtube', 'v3', credentials=c)

def upload(key, privacy='private', thumb=None):
    from googleapiclient.http import MediaFileUpload
    L = json.loads(LOG.read_text()) if LOG.exists() else {}
    if key in L: print('ALREADY', L[key]['url']); return
    y = json.loads((R / 'tools/youtube.json').read_text(encoding='utf-8'))[key]
    vid = R / y['file']
    desc = y['description']
    assert len(desc.encode('utf-8')) < 5000 and len(y['title']) <= 100 and '<' not in y['title'] + desc
    body = {'snippet': {'title': y['title'], 'description': desc, 'tags': y.get('tags', [])[:30],
                        'categoryId': y.get('category', '20'), 'defaultLanguage': 'en'},
            'status': {'privacyStatus': privacy, 'selfDeclaredMadeForKids': False, 'containsSyntheticMedia': True, 'embeddable': True}}
    api = yt()
    req = api.videos().insert(part='snippet,status', body=body, media_body=MediaFileUpload(str(vid), mimetype='video/mp4', chunksize=8 << 20, resumable=True))
    res = None
    while res is None:
        st, res = req.next_chunk()
        if st: print(f'  {int(st.progress() * 100)}%', flush=True)
    url = f"https://youtube.com/shorts/{res['id']}" if y.get('short') else f"https://www.youtube.com/watch?v={res['id']}"
    e = {'id': res['id'], 'url': url, 'title': y['title'], 'privacy': privacy, 'file': y['file'], 'at': datetime.datetime.now().isoformat(timespec='seconds')}
    L[key] = e; LOG.write_text(json.dumps(L, ensure_ascii=False, indent=1)); print('UPLOADED', e, flush=True)
    if thumb:
        try: api.thumbnails().set(videoId=res['id'], media_body=MediaFileUpload(str(R / thumb))).execute(); print('THUMB ok')
        except Exception as ex: print('THUMB failed (channel may not allow custom thumbnails):', ex)

if __name__ == '__main__':
    c = sys.argv[1]
    if c == 'check':
        ch = yt().channels().list(part='snippet', mine=True).execute()
        print('CHANNEL', [(x['id'], x['snippet']['title']) for x in ch.get('items', [])])
    elif c == 'upload': upload(sys.argv[2], arg('--privacy', 'private'), arg('--thumb'))
