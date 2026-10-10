<?php

declare(strict_types=1);

namespace App\Entity;

use Doctrine\ORM\Mapping as ORM;

#[ORM\Entity]
#[ORM\Table(name: 'blog_profile')]
class BlogProfile
{
    #[ORM\Id]
    #[ORM\GeneratedValue(strategy: 'AUTO')]
    #[ORM\Column(name: 'id', type: 'integer')]
    private ?int $id = null;

    #[ORM\Column(name: 'bio', type: 'text', nullable: true)]
    private ?string $bio = null;

    #[ORM\Column(name: 'avatar', type: 'string', length: 100, nullable: true)]
    private ?string $avatar = null;

    #[ORM\OneToOne(targetEntity: BlogUser::class, inversedBy: 'blog_profile')]
    #[ORM\JoinColumn(
        name: 'user_id',
        referencedColumnName: 'id',
        nullable: false,
        onDelete: 'CASCADE',
    )]
    private BlogUser $user;

    public function getId(): ?int
    {
        return $this->id;
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

    public function getUser(): BlogUser
    {
        return $this->user;
    }

    public function setUser(BlogUser $user): static
    {
        $this->user = $user;

        return $this;
    }
}
