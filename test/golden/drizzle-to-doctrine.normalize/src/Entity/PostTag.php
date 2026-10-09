<?php

declare(strict_types=1);

namespace App\Entity;

use DateTimeImmutable;
use Doctrine\ORM\Mapping as ORM;

#[ORM\Entity]
#[ORM\Table(name: 'post_tag')]
#[ORM\HasLifecycleCallbacks]
class PostTag
{
    #[ORM\Column(
        name: 'created_at',
        type: 'datetimetz_immutable',
        options: ['default' => 'CURRENT_TIMESTAMP'],
    )]
    private DateTimeImmutable $createdAt;

    #[ORM\Column(name: 'updated_at', type: 'datetimetz_immutable')]
    private DateTimeImmutable $updatedAt;

    #[ORM\Id]
    #[ORM\ManyToOne(targetEntity: Post::class, inversedBy: 'tags')]
    #[ORM\JoinColumn(
        name: 'post_id',
        referencedColumnName: 'id',
        nullable: false,
        onDelete: 'CASCADE',
    )]
    private Post $post;

    #[ORM\Id]
    #[ORM\ManyToOne(targetEntity: Tag::class, inversedBy: 'posts')]
    #[ORM\JoinColumn(
        name: 'tag_id',
        referencedColumnName: 'id',
        nullable: false,
        onDelete: 'CASCADE',
    )]
    private Tag $tag;

    public function __construct()
    {
        $this->createdAt = new DateTimeImmutable();
    }

    public function getCreatedAt(): DateTimeImmutable
    {
        return $this->createdAt;
    }

    public function setCreatedAt(DateTimeImmutable $createdAt): static
    {
        $this->createdAt = $createdAt;

        return $this;
    }

    public function getUpdatedAt(): DateTimeImmutable
    {
        return $this->updatedAt;
    }

    public function setUpdatedAt(DateTimeImmutable $updatedAt): static
    {
        $this->updatedAt = $updatedAt;

        return $this;
    }

    public function getPost(): Post
    {
        return $this->post;
    }

    public function setPost(Post $post): static
    {
        $this->post = $post;

        return $this;
    }

    public function getTag(): Tag
    {
        return $this->tag;
    }

    public function setTag(Tag $tag): static
    {
        $this->tag = $tag;

        return $this;
    }

    #[ORM\PrePersist]
    #[ORM\PreUpdate]
    public function refreshAutoUpdatedFields(): void
    {
        $this->updatedAt = new DateTimeImmutable();
    }
}
