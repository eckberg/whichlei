"""DATA_DIR for the signal builders (see ../paths.py; duplicated here so these scripts
stay runnable on their own, without importing the parent package)."""
import os

DATA_DIR = os.environ.get(
    'DATA_DIR', os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'data'))
BASE = os.path.join(DATA_DIR, 'signals') + os.sep
