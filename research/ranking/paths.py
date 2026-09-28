"""Shared paths for the ranking study.

DATA_DIR (env var) holds every input: the GLEIF golden-copy CSVs at its root and the
built signal TSVs under DATA_DIR/signals/. Default: research/data, next to this
directory. Everything this code writes (cache, eval output, JS test cases) lives
under this directory instead, so it never touches DATA_DIR.
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get('DATA_DIR', os.path.join(HERE, '..', 'data'))
SIG = os.path.join(DATA_DIR, 'signals') + os.sep
CACHE = os.path.join(HERE, 'cache') + os.sep
LOGS = os.path.join(HERE, 'logs') + os.sep
EVAL = os.path.join(HERE, 'eval') + os.sep
PORT = os.path.join(HERE, 'port') + os.sep
RANKING_PY = os.path.join(HERE, 'ranking.py')
RR_ZIP = os.path.join(DATA_DIR, 'rr.csv.zip')
