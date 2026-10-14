FROM buildkite/puppeteer:5.2.1
WORKDIR /usr/src/apps
# Fix apt sources for Debian 10 (buster is archived now) and Google Chrome key
RUN sed -i 's|http://deb.debian.org/debian|http://archive.debian.org/debian|g' /etc/apt/sources.list && \
    sed -i 's|http://security.debian.org/debian-security|http://archive.debian.org/debian-security|g' /etc/apt/sources.list && \
    sed -i '/buster-updates/d' /etc/apt/sources.list && \
    rm -f /etc/apt/sources.list.d/google.list
# Install gnupg and import Google key
RUN apt-get install -y wget gnupg && \
    wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | apt-key add -
# Now update apt lists
RUN apt-get update -o Acquire::Check-Valid-Until=false
RUN apt-get -y install git
RUN apt-get -y install vim
RUN mkdir /smexports-api
RUN git clone https://github.com/TitanXV4000/smapiexporter.git
WORKDIR /usr/src/apps/smapiexporter
RUN npm install
# If you are building your code for production
# RUN npm ci --only=production
CMD [ "node", "index.js" ]
