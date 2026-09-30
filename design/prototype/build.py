import sys, pathlib
d = pathlib.Path(__file__).parent
data, scorer, out = sys.argv[1], sys.argv[2], sys.argv[3]
html = f"""<title>whichlei</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Red+Hat+Mono:wght@400;500;700&display=swap">
<style>
{(d/'shared.css').read_text()}
{(d/'page.css').read_text()}
</style>
{(d/'body.html').read_text()}
<script>
{pathlib.Path(data).read_text()}
</script>
<script>
{pathlib.Path(scorer).read_text()}
</script>
<script>
{(d/'app.js').read_text()}
</script>
"""
pathlib.Path(out).write_text(html)
print(out, len(html.encode()), "bytes")
