<?php

declare(strict_types=1);

namespace App\Entity;

use Doctrine\ORM\Mapping as ORM;

#[ORM\Entity]
#[ORM\Table(name: 'PostTags')]
class PostTags
{
    #[ORM\Id]
    #[ORM\Column(name: 'id', type: 'integer')]
    private int $id;

    #[ORM\Column(name: 'post_id', type: 'integer')]
    private int $post_id;

    #[ORM\Column(name: 'tag_id', type: 'integer')]
    private int $tag_id;

    public function getId(): int
    {
        return $this->id;
    }

    public function setId(int $id): static
    {
        $this->id = $id;

        return $this;
    }

    public function getPostId(): int
    {
        return $this->post_id;
    }

    public function setPostId(int $postId): static
    {
        $this->post_id = $postId;

        return $this;
    }

    public function getTagId(): int
    {
        return $this->tag_id;
    }

    public function setTagId(int $tagId): static
    {
        $this->tag_id = $tagId;

        return $this;
    }
}
