# Harbor disposable test VM (generated build output; see docs/OPERATOR_GUIDE.md).
# One VM, pinned Ubuntu 24.04 x86-64 box, base OS only: no Node/npm/Docker preinstalled so
# bootstrap evidence (A01) stays valid. Harbor state lives inside the VM (/var/lib/harbor).
#
#   vagrant up            # create/boot
#   vagrant ssh           # shell
#   vagrant halt          # clean shutdown (reboot test: halt + up, or `sudo reboot` inside)
#   vagrant snapshot save clean && vagrant snapshot restore clean
#   vagrant destroy -f    # reset to nothing
#
# Forwarded ports (all bound to host loopback only):
#   18000 -> Harbor UI/API
#   18080-18085 -> the loopback app ports the three demo apps actually use (first six allocations)
# Any additional port: ssh -L <port>:127.0.0.1:<port> vagrant@<vm>  (same local and remote port).
Vagrant.configure("2") do |config|
  config.vm.box = "bento/ubuntu-24.04"
  config.vm.box_version = "202510.26.0"
  config.vm.box_check_update = false
  config.vm.hostname = "harbor-test"
  config.vm.define "harbor-test"

  config.vm.synced_folder ".", "/vagrant", disabled: false

  config.vm.network "forwarded_port", guest: 18000, host: 18000, host_ip: "127.0.0.1"
  (18080..18085).each do |p|
    config.vm.network "forwarded_port", guest: p, host: p, host_ip: "127.0.0.1"
  end

  config.vm.provider "virtualbox" do |vb|
    vb.name = "harbor-test"
    vb.cpus = 2
    vb.memory = 4096
  end
  config.vm.provider "vmware_desktop" do |v|
    v.vmx["numvcpus"] = "2"
    v.vmx["memsize"] = "4096"
  end
  config.vm.provider "libvirt" do |lv|
    lv.cpus = 2
    lv.memory = 4096
  end
  # No provisioning on purpose: Harbor's bootstrap must work on a base OS.
end
