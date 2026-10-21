<?php

declare(strict_types=1);

namespace App\Entity;

use Doctrine\ORM\Mapping as ORM;

#[ORM\Entity]
#[ORM\Table(name: 'Profile')]
class Profile
{
    #[ORM\Id]
    #[ORM\Column(name: 'id', type: 'integer')]
    private int $id;

    #[ORM\Column(name: 'bio', type: 'text', nullable: true)]
    private ?string $bio = null;

    #[ORM\Column(name: 'avatar', type: 'string', length: 100, nullable: true)]
    private ?string $avatar = null;

    #[ORM\Column(name: 'user_id', type: 'integer')]
    private int $user_id;

    public function getId(): int
    {
        return $this->id;
    }

    public function setId(int $id): static
    {
        $this->id = $id;

        return $this;
    }

    public function getBio(): ?string
    {
        return $this->bio;
    }

    public function setBio(?string $bio): static
    {
        $this->bio = $bio;

        return $this;
    }

    public function getAvatar(): ?string
    {
        return $this->avatar;
    }

    public function setAvatar(?string $avatar): static
    {
        $this->avatar = $avatar;

        return $this;
    }

    public function getUserId(): int
    {
        return $this->user_id;
    }

    public function setUserId(int $userId): static
    {
        $this->user_id = $userId;

        return $this;
    }
}
