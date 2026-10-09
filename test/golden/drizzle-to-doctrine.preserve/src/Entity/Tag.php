<?php

declare(strict_types=1);

namespace App\Entity;

use Doctrine\Common\Collections\ArrayCollection;
use Doctrine\Common\Collections\Collection;
use Doctrine\ORM\Mapping as ORM;

#[ORM\Entity]
#[ORM\Table(name: 'blog_tag')]
class Tag
{
    #[ORM\Id]
    #[ORM\GeneratedValue(strategy: 'AUTO')]
    #[ORM\Column(name: 'id', type: 'integer')]
    private ?int $id = null;

    #[ORM\Column(name: 'label', type: 'string', length: 50)]
    private string $label;

    /** @var Collection<int, PostTag> */
    #[ORM\OneToMany(targetEntity: PostTag::class, mappedBy: 'tag')]
    private Collection $posts;

    public function __construct()
    {
        $this->posts = new ArrayCollection();
    }

    public function getId(): ?int
    {
        return $this->id;
    }

    public function getLabel(): string
    {
        return $this->label;
    }

    public function setLabel(string $label): static
    {
        $this->label = $label;

        return $this;
    }

    /**
     * @return Collection<int, PostTag>
     */
    public function getPosts(): Collection
    {
        return $this->posts;
    }

    public function addPost(PostTag $post): static
    {
        if (!$this->posts->contains($post)) {
            $this->posts->add($post);
            $post->setTag($this);
        }

        return $this;
    }

    public function removePost(PostTag $post): static
    {
        if ($this->posts->removeElement($post)) {
            // The owning side is required, so it is not unset here.
        }

        return $this;
    }
}
