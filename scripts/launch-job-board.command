#!/bin/zsh
# Job Board — launches the Job Board app built from this project. The work is done
# by launch-app.command; this wrapper only names which of the three apps to
# build and open.
export APP_VARIANT="job-board"
exec "${0:A:h}/launch-app.command"
