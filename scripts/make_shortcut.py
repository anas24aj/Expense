"""Write the unsigned iOS Shortcut "Ledger: Send SMS" (a binary plist) to the path given, default ledger-sms.unsigned.shortcut.

It holds no key: on install, iOS asks for the setup copied from More → Phones → iPhone ({"url": ..., "key": ...}).
Each run POSTs {sender, body, received_at: ISO} with "Authorization: Bearer <key>" to the setup's url
(/api/ingest/sms/batch). A Messages automation ("Message Contains" SAR / INR / Rs, Run Immediately) runs it with the
message as input. Sign it on a Mac with scripts/sign_shortcut.sh, which also runs this.
"""
import plistlib
import sys
import uuid

OBJ = '￼'  # where a variable sits inside a text field


def var(uid, name):
    return {'OutputUUID': uid, 'Type': 'ActionOutput', 'OutputName': name}


def attach(v):
    return {'Value': v, 'WFSerializationType': 'WFTextTokenAttachment'}


def text(s, *vars_):
    """Text with each OBJ in s replaced by the next variable."""
    spots, at = {}, -1
    for v in vars_:
        at = s.index(OBJ, at + 1)
        spots[f'{{{len(s[:at].encode("utf-16-le")) // 2}, 1}}'] = v
    return {'Value': {'string': s, 'attachmentsByRange': spots}, 'WFSerializationType': 'WFTextTokenString'}


def fields(**kv):
    return {'Value': {'WFDictionaryFieldValueItems': [{'WFItemType': 0, 'WFKey': text(k), 'WFValue': v} for k, v in kv.items()]},
            'WFSerializationType': 'WFDictionaryFieldValue'}


def action(ident, uid=None, **params):
    if uid:
        params['UUID'] = uid
    return {'WFWorkflowActionIdentifier': 'is.workflow.actions.' + ident, 'WFWorkflowActionParameters': params}


def shortcut():
    setup, parsed, url, key, day = (str(uuid.uuid4()).upper() for _ in range(5))
    message = {'Type': 'ExtensionInput'}
    sender = {'Type': 'ExtensionInput', 'Aggrandizements': [{'Type': 'WFPropertyVariableAggrandizement', 'PropertyName': 'Sender'}]}
    actions = [
        action('gettext', setup, WFTextActionText=''),  # filled by the import question below
        action('detect.dictionary', parsed, WFInput=attach(var(setup, 'Text'))),
        action('getvalueforkey', url, WFInput=attach(var(parsed, 'Dictionary')), WFDictionaryKey='url'),
        action('getvalueforkey', key, WFInput=attach(var(parsed, 'Dictionary')), WFDictionaryKey='key'),
        action('format.date', day, WFDateFormatStyle='ISO 8601', WFISO8601IncludeTime=True,
               WFDate=attach({'Type': 'CurrentDate'})),
        action('downloadurl', None, WFURL=text(OBJ, var(url, 'Dictionary Value')), WFHTTPMethod='POST', ShowHeaders=True,
               WFHTTPHeaders=fields(Authorization=text('Bearer ' + OBJ, var(key, 'Dictionary Value'))),
               WFHTTPBodyType='JSON',
               WFJSONValues=fields(sender=text(OBJ, sender), body=text(OBJ, message), received_at=text(OBJ, var(day, 'Formatted Date')))),
    ]
    return {
        'WFWorkflowActions': actions,
        'WFWorkflowImportQuestions': [{'ActionIndex': 0, 'Category': 'Parameter', 'ParameterKey': 'WFTextActionText', 'DefaultValue': '',
                                       'Text': 'Paste the setup copied from Ledger → More → Phones → iPhone'}],
        'WFWorkflowInputContentItemClasses': ['WFStringContentItem', 'WFGenericFileContentItem'],
        'WFWorkflowHasShortcutInputVariables': True,
        'WFWorkflowIcon': {'WFWorkflowIconStartColor': 4282601983, 'WFWorkflowIconGlyphNumber': 59511},
        'WFWorkflowClientVersion': '2302.0.4',
        'WFWorkflowMinimumClientVersion': 900,
        'WFWorkflowMinimumClientVersionString': '900',
        'WFWorkflowTypes': [],
        'WFWorkflowOutputContentItemClasses': [],
    }


if __name__ == '__main__':
    out = sys.argv[1] if len(sys.argv) > 1 else 'ledger-sms.unsigned.shortcut'
    with open(out, 'wb') as f:
        plistlib.dump(shortcut(), f, fmt=plistlib.FMT_BINARY)
    print(out)
