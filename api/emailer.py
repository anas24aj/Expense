"""Mail through Resend's HTTP API when RESEND_API_KEY and MAIL_FROM are set; otherwise nothing is sent."""
import json
import os
import sys
from urllib.request import Request, urlopen


def configured():
    return bool(os.environ.get('RESEND_API_KEY') and os.environ.get('MAIL_FROM'))


def send(to, subject, text):
    """True when Resend accepted the message."""
    if not configured():
        return False
    req = Request('https://api.resend.com/emails', method='POST',
                  data=json.dumps({'from': os.environ['MAIL_FROM'], 'to': [to], 'subject': subject, 'text': text}).encode(),
                  headers={'Authorization': 'Bearer ' + os.environ['RESEND_API_KEY'], 'Content-Type': 'application/json'})
    try:
        with urlopen(req, timeout=8) as r:
            return 200 <= r.status < 300
    except OSError as e:
        print(f'mail not sent: {type(e).__name__}', file=sys.stderr)
        return False
