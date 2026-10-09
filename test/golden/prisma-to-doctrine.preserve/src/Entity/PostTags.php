<?php

declare(strict_types=1);

namespace App\Entity;

use Doctrine\ORM\Mapping as ORM;

#[ORM\Entity]
#[ORM\Table(name: 'blog_post_tags')]
#[ORM\UniqueConstraint(columns: ['post_id', 'tag_id'])]
class PostTags
{
    #[ORM\Id]
    #[ORM\GeneratedValue(strategy: 'AUTO')]
    #[ORM\Column(name: 'id', type: 'integer')]
    private ?int $id = null;

    #[ORM\ManyToOne(targetEntity: Post::class, inversedBy: 'tags')]
    #[ORM\JoinColumn(
        name: 'post_id',
        referencedColumnName: 'id',
        nullable: false,
        onDelete: 'CASCADE',
    )]
    private Post $post;

    #[ORM\ManyToOne(targetEntity: Tag::class, inversedBy: 'posts')]
    #[ORM\JoinColumn(
        name: 'tag_id',
        referencedColumnName: 'id',
        nullable: false,
        onDelete: 'CASCADE',
    )]
    private Tag $tag;

    public function getId(): ?int
    {
        return $this->id;
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
}
