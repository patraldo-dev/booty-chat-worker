#!/bin/bash

    # Check if a commit message is provided as an argument
    if [ -z "$1" ]; then
      echo "Usage: $0 \"Your commit message\""
      exit 1
    fi

    COMMIT_MESSAGE="$1"

    # Add all changes to the staging area
    git add .

    # Commit the changes with the provided message
    git commit -m "$COMMIT_MESSAGE"

    # Push the changes to the remote repository (assuming 'origin' and 'main' or 'master' branch)
    # You might need to adjust 'main' to 'master' depending on your repository's default branch
    git push origin HEAD

    echo "Changes added, committed, and pushed successfully!"
