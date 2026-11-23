"""Domain model v2 and the money engine's HTTP surface. See docs/brain/domain-model.md and docs/brain/api.md."""


def handle(db, environ, method, path, query, respond):
    return respond('404 Not Found', {'error': 'not found'})
