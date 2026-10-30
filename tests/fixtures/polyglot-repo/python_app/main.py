import os
import sys
import requests
from .utils import compute_hash
from .models.user import User

def main():
    u = User("alice")
    print(compute_hash(u.username))

if __name__ == "__main__":
    main()

